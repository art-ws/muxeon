// Federation wiring (§18, FR-137…FR-146, FR-149/FR-150) — the composition
// root's federation half. The router owns authorization and enqueue on both
// sides (§10.26); this module assembles everything around it: the router's
// federation ports (config + journal knowledge), one persistent link queue and
// egress dispatcher per link (§18.5, store-and-forward), the link clients
// (imports, FR-139), the listener (accepts, FR-138) and the status publisher
// (FR-149) — all inside @teamai/federation's manager.

import { randomUUID } from "node:crypto";
import {
  DEFAULT_FEDERATION_PUBLISH_STATUS,
  DEFAULT_FEDERATION_STATUS_DEBOUNCE_MS,
  DEFAULT_IMPORT_TRANSIT,
  type TeamaiConfig,
} from "@teamai/config";
import type { AgentStatus, StatusProjection } from "@teamai/core";
import {
  FederationListener,
  FederationManager,
  LinkClient,
  type LinkConnection,
  type OwnActor,
  type RemotePeer,
  type RemoteRegistry,
} from "@teamai/federation";
import {
  EgressDispatcher,
  type LinkRecord,
  type Router,
  type RouterFederation,
  type TransportLog,
  ensureSessionQueue,
  fedQueueRoot,
  isLinkRecord,
  loadSessionDoneIds,
  sessionPaths,
} from "@teamai/orchestrator";

/** How deep the reply-correlation scan looks into a pair's journal (§18.10-3). */
const CORRELATION_SCAN_LIMIT = 1000;

/** Link egress retry cadence — a down link re-probes gently, not on the hot poll. */
const LINK_EGRESS_POLL_MS = 1000;

/**
 * The router's federation ports (§10.26), built BEFORE the router from config +
 * the transport journal. Returns undefined when the config has no federation —
 * the router then treats an FQN as UNKNOWN_PEER exactly as before (FR-146).
 */
export function buildRouterFederation(
  config: TeamaiConfig,
  transportLog: TransportLog,
): RouterFederation | undefined {
  const imports = config.imports ?? [];
  if (imports.length === 0 && config.federation === undefined) return undefined;
  const importByName = new Map(imports.map((entry) => [entry.name, entry]));
  const acceptNames = new Set((config.federation?.accept ?? []).map((entry) => entry.name));
  const exportedToLocal = new Map<string, string>();
  for (const agent of config.agents) {
    if (agent.exported !== undefined) {
      exportedToLocal.set(agent.exported === true ? agent.name : agent.exported, agent.name);
    }
  }
  for (const user of config.users ?? []) {
    if (user.exported !== undefined) {
      exportedToLocal.set(user.exported === true ? user.name : user.exported, user.name);
    }
  }
  return {
    linkKind: (name) =>
      importByName.has(name) ? "import" : acceptNames.has(name) ? "accept" : null,
    transitAllowed: (name) => importByName.get(name)?.transit ?? DEFAULT_IMPORT_TRANSIT,
    exportedToLocal: (name) => exportedToLocal.get(name) ?? null,
    // Reply-correlation (§18.10-3): the transport journal is the durable memory of
    // who exchanged what — a reply after a restart still correlates (§10.25 spirit).
    hasCorrelation: async (local, remoteFqn, replyTo) => {
      if (replyTo === undefined) return false;
      const records = await transportLog.pair(local, remoteFqn, CORRELATION_SCAN_LIMIT);
      return records.some((record) => record.id === replyTo);
    },
  };
}

export interface WireFederationOptions {
  readonly config: TeamaiConfig;
  readonly root: string;
  readonly router: Router;
  readonly signal: AbortSignal;
  /** Start the loops (default true) — the same seam the other dispatchers get. */
  readonly start?: boolean;
  /** Live status of a LOCAL agent (§5.1) — feeds the projection (FR-149). */
  readonly agentStatusOf: (localName: string) => AgentStatus | undefined;
  /** Live presence of a LOCAL user (FR-133) — the OWNER computes it (§18.4). */
  readonly presenceOf: (userName: string) => "online" | "offline";
  /** Pause §16 / DND FR-134 of a local actor. */
  readonly isPaused: (name: string) => boolean;
  readonly warn?: (message: string) => void;
}

export interface FederationHandle {
  readonly instanceId: string;
  readonly manager: FederationManager;
  readonly registry: RemoteRegistry;
  /** The bound listener port (config `federation.port`, 0 ⇒ ephemeral, resolved). */
  readonly port?: number;
  /** Import names — surfaces gate remote peers on a topology edge to these nodes. */
  readonly importNames: readonly string[];
  /** Remote peers visible through an edge on `node` (FR-140) — imports and relay
   * accepts (§18.11.8-2) are peer nodes; [] for anything else. */
  readonly peersOf: (node: string) => readonly RemotePeer[];
  readonly egresses: ReadonlyMap<string, EgressDispatcher>;
  readonly runs: readonly Promise<void>[];
  readonly stop: () => Promise<void>;
}

const stderrWarn = (message: string): void => {
  process.stderr.write(`teamai: warning: ${message}\n`);
};

/** Wires federation, or returns undefined when the config has none (FR-146). */
export async function wireFederation(
  options: WireFederationOptions,
): Promise<FederationHandle | undefined> {
  const { config, root, router, signal } = options;
  const imports = config.imports ?? [];
  const federation = config.federation;
  if (imports.length === 0 && federation === undefined) return undefined;
  const warn = options.warn ?? stderrWarn;
  const start = options.start ?? true;
  const accepts = federation?.accept ?? [];
  const acceptNames = accepts.map((entry) => entry.name);
  // Relay mode (§18.11, FR-152/FR-153): accepts this hub consented to relay, and
  // imports this satellite publishes up. Either can exist without the other —
  // the flags only meet in the handshake (invariant §10.28).
  const relayAccepts = accepts.filter((entry) => entry.relay === true).map((entry) => entry.name);
  const publishesAny = imports.some((entry) => entry.publish === true);
  const linkNames = [...new Set([...imports.map((entry) => entry.name), ...acceptNames])];

  // §18.5: one persistent maildir per link under <root>/fed/ — routing to a down
  // link just accumulates (store-and-forward, §10.25), exactly like a down agent.
  const fedRoot = fedQueueRoot(root);
  for (const link of linkNames) await ensureSessionQueue(fedRoot, link);

  // §18.4: the per-boot instance id — the cycle guard's identity. Exchanged on
  // every handshake, carried in transit paths; nothing persists it.
  const instanceId = randomUUID();

  const ownActors: OwnActor[] = [];
  const exportNameByLocal = new Map<string, string>();
  for (const agent of config.agents) {
    if (agent.exported === undefined) continue;
    const exportName = agent.exported === true ? agent.name : agent.exported;
    ownActors.push({ local: agent.name, exportName, type: "agent" });
    exportNameByLocal.set(agent.name, exportName);
  }
  for (const user of config.users ?? []) {
    if (user.exported === undefined) continue;
    const exportName = user.exported === true ? user.name : user.exported;
    ownActors.push({ local: user.name, exportName, type: "user" });
    exportNameByLocal.set(user.name, exportName);
  }

  const publishStatus = federation?.publishStatus ?? DEFAULT_FEDERATION_PUBLISH_STATUS;
  const projectionOf = (actor: OwnActor): StatusProjection =>
    actor.type === "agent"
      ? {
          actor: actor.exportName,
          type: "agent",
          status: options.agentStatusOf(actor.local) ?? "down",
          paused: options.isPaused(actor.local),
        }
      : {
          actor: actor.exportName,
          type: "user",
          presence: options.presenceOf(actor.local),
          paused: options.isPaused(actor.local),
        };

  const manager = new FederationManager({
    instanceId,
    onIngress: (record, link) => router.routeFederatedIngress(record, link),
    exportNameOf: (local) => exportNameByLocal.get(local) ?? null,
    ownActors,
    projectionOf,
    transitImports: imports
      .filter((entry) => entry.transit ?? DEFAULT_IMPORT_TRANSIT)
      .map((entry) => entry.name),
    relayAccepts,
    publishStatus,
    statusDebounceMs: federation?.statusDebounceMs ?? DEFAULT_FEDERATION_STATUS_DEBOUNCE_MS,
    warn,
  });

  const runs: Promise<void>[] = [];

  // Link egress dispatchers (§18.5): drain <root>/fed/<link>/ into the live
  // connection; no connection / no ack ⇒ the record stays in cur/ and re-sends
  // (at-least-once §10.25). One dispatcher per link — §10.8 generalized.
  const egresses = new Map<string, EgressDispatcher>();
  for (const link of linkNames) {
    const egress = new EgressDispatcher({
      paths: sessionPaths(fedRoot, link),
      doneIds: await loadSessionDoneIds(fedRoot, link),
      pollIntervalMs: LINK_EGRESS_POLL_MS,
    });
    egress.registerDeliver(async (signal) => {
      if (!isLinkRecord(signal)) {
        // A non-link record in a link queue is a poisoned write — completing it
        // with a warning beats retrying it forever (the queue must keep moving).
        warn(`federation: dropping a non-link record "${signal.id}" in queue "${link}"`);
        return;
      }
      await manager.deliver(link, signal as LinkRecord);
    });
    if (start) runs.push(egress.run(signal));
    egresses.set(link, egress);
  }

  // Link clients (FR-139): one persistent connection per import, reconnect with
  // backoff; the registry learns the surface on every (re)connect and forgets
  // every status the moment the link dies (§10.27).
  for (const entry of imports) {
    let connection: LinkConnection | null = null;
    const client = new LinkClient({
      name: entry.name,
      url: entry.url,
      token: entry.token,
      publish: entry.publish === true,
      statusPublished: publishStatus,
      onUp: (handshake, actors, send) => {
        connection = { send: (frame) => send(JSON.stringify(frame)) };
        manager.attach(entry.name, connection);
        manager.registry.linkUp(entry.name, handshake.statusPublished);
        manager.registry.surface(entry.name, actors.actors);
        // Relay negotiation outcome (§18.11.5): re-decided on EVERY reconnect —
        // the hub may have changed its accept's `relay` between link lives.
        if (entry.publish === true && handshake.relay === true) {
          manager.publishGranted(entry.name, connection);
        } else {
          manager.publishRevoked(entry.name);
        }
      },
      onDown: () => {
        if (connection !== null) manager.detach(entry.name, connection);
        connection = null;
        manager.publishRevoked(entry.name);
        manager.registry.linkDown(entry.name);
      },
      onMessage: (raw) => {
        if (connection !== null) void manager.handleMessage(entry.name, raw, connection, "client");
      },
      warn,
    });
    if (start) runs.push(client.run(signal));
  }

  // The listener (FR-138): the accept side — a separate surface on its own port.
  // For a relay accept (§18.11) the connection doubles as the registry's source:
  // link state and the satellite's declared statusPublished feed the same
  // honesty rules an import's do (§10.27).
  const relayAcceptSet = new Set(relayAccepts);
  const satelliteStatusPublished = new Map<string, boolean>();
  let listener: FederationListener | undefined;
  if (federation !== undefined) {
    listener = new FederationListener({
      port: federation.port,
      ...(federation.bind !== undefined ? { bind: federation.bind } : {}),
      instanceId,
      accepts,
      statusPublished: publishStatus,
      surface: () => manager.surface(),
      statuses: () => manager.statuses(),
      onHandshake: (accept, request) => {
        satelliteStatusPublished.set(accept, request.statusPublished ?? true);
      },
      onOpen: (accept, send) => {
        const connection: LinkConnection = { send: (frame) => send(JSON.stringify(frame)) };
        manager.acceptOpened(accept, connection);
        if (relayAcceptSet.has(accept)) {
          manager.registry.linkUp(accept, satelliteStatusPublished.get(accept) ?? true);
        }
        return connection;
      },
      onClose: (accept, handle) => {
        manager.detach(accept, handle as LinkConnection);
        if (relayAcceptSet.has(accept)) manager.registry.linkDown(accept);
      },
      onMessage: (accept, raw, handle) => {
        void manager.handleMessage(accept, raw, handle as LinkConnection, "accept");
      },
      warn,
    });
    listener.start();
  }
  // The publisher (FR-149): surface refreshes for everyone, coalesced status
  // deltas when publishing — ephemeral frames only, nothing queued (§10.27).
  // A satellite that publishes (§18.11.2) needs it too, listener or not.
  if (start && (federation !== undefined || publishesAny)) {
    runs.push(manager.runPublisher(acceptNames, signal));
  }

  const importNames = imports.map((entry) => entry.name);
  // §18.11.8-2: a relay branch is visible to the hub's local plane exactly like
  // an import — an edge on the accept node reveals its published actors.
  const peerNodes = new Set([...importNames, ...relayAccepts]);
  return {
    instanceId,
    manager,
    registry: manager.registry,
    ...(listener !== undefined ? { port: listener.port } : {}),
    importNames,
    peersOf: (node) => (peerNodes.has(node) ? manager.registry.peersOf(node) : []),
    egresses,
    runs,
    stop: async () => {
      await listener?.stop();
    },
  };
}
