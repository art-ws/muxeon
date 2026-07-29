// Channel wiring (T30, §8.2, FR-37): for each configured channel, build the
// connector, run the operator pseudo-session's egress dispatcher, and inject the
// connector's `deliver` port into it (key — the operator; §7.5 guarantees one
// channel per operator). Start order per §8.2: egress dispatchers first, then
// connectors — pending/ accumulated before registration drains on it (NFR-4).
// Inbound goes through the router only (§10.2); a refusal becomes a
// RouteRefusedError the connector reports back to the operator (§3.2).

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ChannelConnector,
  RouteRefusedError,
  SlackConnector,
  TelegramConnector,
  WebConnector,
  createSlackWebApi,
  createTelegramBotApi,
} from "@teamai/channels";
import type { ChannelConfig } from "@teamai/config";
import type { Message } from "@teamai/core";
import {
  type BlobStore,
  EgressDispatcher,
  type Router,
  createBlobStore,
  loadSessionDoneIds,
  parseRetainAge,
  sessionPaths,
} from "@teamai/orchestrator";
import {
  HistoryStore,
  type TransportObservability,
  WebchatConnector,
  type WebchatLifecycle,
  type WebchatPorts,
} from "@teamai/webchat";
import { buildInfo } from "./build-info";

export interface ConnectorDeps {
  /** Agent names addressable by @token (§3.2). */
  readonly knownAgents: readonly string[];
  /** Blob store under <root>/blobs/ (§5.3, §8.7). */
  readonly blobs: BlobStore;
  /** <config_dir> (§7.4) — the webchat history root lives under it (§12.3). */
  readonly configDir: string;
  /** Instance label shown in the panel (FR-90, §12.7) — already defaulted to hostname(). */
  readonly instanceName?: string;
  /** Read-only dynamics ports for the bound operator (webchat, §12.4/FR-40). */
  readonly ports?: WebchatPorts;
  /** Read-only transport observability (webchat, §12.4/FR-48). */
  readonly transport?: TransportObservability;
  /** Narrow neighbor-scoped lifecycle port (webchat, §12.4/FR-65). */
  readonly lifecycle?: WebchatLifecycle;
}

/** Builds a connector from its (validated, $env-resolved) config; injectable for tests. */
export type ConnectorFactory = (config: ChannelConfig, deps: ConnectorDeps) => ChannelConnector;

export interface ChannelRuntime {
  readonly operator: string;
  readonly type: string;
  readonly connector: ChannelConnector;
  readonly egress: EgressDispatcher;
}

export interface WireChannelsOptions {
  readonly channels: readonly ChannelConfig[];
  readonly router: Router;
  /** Queue root <root> (§5.3); operator pseudo-session queues live under it. */
  readonly root: string;
  /** <config_dir> (§7.4) — webchat history root (§12.3). */
  readonly configDir: string;
  /** Instance label for the panel (FR-90, §12.7); defaulted to hostname() by the caller. */
  readonly instanceName?: string;
  /** Builds the read-only dynamics ports for an operator (webchat, §12.4). */
  readonly makePorts?: (operator: string) => WebchatPorts;
  /** Builds the narrow lifecycle port for an operator (webchat, §12.4/FR-65). */
  readonly makeLifecycle?: (operator: string) => WebchatLifecycle;
  /** Server-wide transport observability port (webchat, §12.4/FR-48). */
  readonly transport?: TransportObservability;
  readonly knownAgents: readonly string[];
  /** Aborts the egress dispatcher loops (shared with the agent dispatchers). */
  readonly signal: AbortSignal;
  readonly makeConnector?: ConnectorFactory;
}

export interface ChannelsHandle {
  /** Keyed by operator name (one channel per operator, §7.5). */
  readonly channels: ReadonlyMap<string, ChannelRuntime>;
  /** The running egress loops; join them on shutdown. */
  readonly runs: readonly Promise<void>[];
  /** Stops the connectors (the egress loops stop via the shared signal). */
  stop(): Promise<void>;
}

export async function wireChannels(options: WireChannelsOptions): Promise<ChannelsHandle> {
  const makeConnector = options.makeConnector ?? defaultConnectorFactory;
  const blobs = await createBlobStore(options.root);
  const channels = new Map<string, ChannelRuntime>();
  const runs: Promise<void>[] = [];

  for (const config of options.channels) {
    const operator = config.bindOperator;
    const egress = new EgressDispatcher({
      paths: sessionPaths(options.root, operator),
      doneIds: await loadSessionDoneIds(options.root, operator),
    });
    const ports = options.makePorts?.(operator);
    const lifecycle = options.makeLifecycle?.(operator);
    const connector = makeConnector(config, {
      knownAgents: options.knownAgents,
      blobs,
      configDir: options.configDir,
      ...(options.instanceName !== undefined ? { instanceName: options.instanceName } : {}),
      ...(ports !== undefined ? { ports } : {}),
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
      ...(lifecycle !== undefined ? { lifecycle } : {}),
    });

    // Inbound bridge — the router is the single delivery point (§8.2/§10.2); a
    // refusal surfaces to the operator in the same channel (§3.2).
    const onInbound = async (message: Message): Promise<void> => {
      const result = await options.router.route(message);
      if (!result.ok) throw new RouteRefusedError(result.code, message.to);
    };

    runs.push(egress.run(options.signal)); // dispatcher before connector (§8.2)
    await connector.start(onInbound);
    egress.registerDeliver((message) => connector.deliver(message)); // accumulated pending drains now
    channels.set(operator, { operator, type: config.type, connector, egress });
  }

  return {
    channels,
    runs,
    stop: async () => {
      await Promise.allSettled([...channels.values()].map((c) => c.connector.stop()));
    },
  };
}

// The built SPA (§12.7): a soft asset lookup, not a runtime import — webchat-ui
// stays out of the §8 dependency graph; absence just means the panel serves
// API-only. Two layouts have to work:
//
//   workspace  packages/server/src/… → resolve @teamai/webchat-ui, take its dist/
//   published  dist/index.js         → dist/ui/ (npm tarball: no workspace to resolve)
//
// The published layout is checked FIRST because it is unambiguous: if `ui/` sits
// next to the running bundle, that is the panel that shipped with it.
function resolveUiDist(): string | undefined {
  const shipped = join(import.meta.dir, "ui");
  if (existsSync(join(shipped, "index.html"))) return shipped;
  try {
    const pkg = Bun.resolveSync("@teamai/webchat-ui/package.json", import.meta.dir);
    const dist = join(pkg, "..", "dist");
    return existsSync(join(dist, "index.html")) ? dist : undefined;
  } catch {
    return undefined;
  }
}

// The production factory: channel `type` → connector. An unknown type or a missing
// secret/field is a boot-time error (fail-fast, §7.5); secrets arrive here already
// resolved from $env (§7.3) and never appear in the error.
function defaultConnectorFactory(config: ChannelConfig, deps: ConnectorDeps): ChannelConnector {
  const common = {
    bindOperator: config.bindOperator,
    ...(config.defaultTarget !== undefined ? { defaultTarget: config.defaultTarget } : {}),
    knownAgents: deps.knownAgents,
    blobs: deps.blobs,
  };
  const requireToken = (): string => {
    const token = config.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `channel for "${config.bindOperator}": ${config.type} requires a token (§7.3)`,
      );
    }
    return token;
  };

  if (config.type === "telegram") {
    return new TelegramConnector({ ...common, api: createTelegramBotApi(requireToken()) });
  }
  if (config.type === "slack") {
    const channel = config.channel;
    if (typeof channel !== "string" || channel.length === 0) {
      throw new Error(`channel for "${config.bindOperator}": slack requires a channel id`);
    }
    return new SlackConnector({ ...common, api: createSlackWebApi(requireToken(), { channel }) });
  }
  if (config.type === "web") {
    const port = config.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`channel for "${config.bindOperator}": web requires a port (0..65535)`);
    }
    const deliverUrl = typeof config.deliverUrl === "string" ? config.deliverUrl : undefined;
    const secret = typeof config.secret === "string" ? config.secret : undefined;
    return new WebConnector({
      ...common,
      port,
      ...(deliverUrl !== undefined ? { deliverUrl } : {}),
      ...(secret !== undefined ? { secret } : {}),
    });
  }
  if (config.type === "webchat") {
    // Shapes are guaranteed by the §12.2 validation rules (config/validate.ts);
    // re-checked cheaply here because the factory is reachable in tests directly.
    const port = config.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`channel for "${config.bindOperator}": webchat requires a port (§12.2)`);
    }
    const auth = config.auth;
    const password =
      typeof auth === "object" && auth !== null && !Array.isArray(auth)
        ? (auth as Record<string, unknown>).password
        : undefined;
    if (typeof password !== "string" || password.length === 0) {
      throw new Error(
        `channel for "${config.bindOperator}": webchat requires auth.password (§12.2/§7.3)`,
      );
    }
    const bind = typeof config.bind === "string" ? config.bind : undefined;
    // basePath (T120, §12.2): the URL prefix the whole panel mounts under —
    // grammar enforced by the §12.2 rules at load.
    const basePath = typeof config.basePath === "string" ? config.basePath : undefined;
    // Durable TTL sessions (§12.6, FR-57): a restart must not log the operator
    // out. ttl and renew (FR-86) share the retain.age grammar (§7.1); invalid →
    // boot error.
    const sessionConfig = (auth as { session?: { ttl?: unknown; renew?: unknown } }).session;
    const sessionDuration = (field: "ttl" | "renew"): number | undefined => {
      const value = sessionConfig?.[field];
      if (typeof value !== "string") return undefined;
      try {
        return parseRetainAge(value);
      } catch {
        throw new Error(
          `channel for "${config.bindOperator}": invalid auth.session.${field} "${value}" (expected <n>ms|s|m|h|d, e.g. "1d")`,
        );
      }
    };
    const ttlMs = sessionDuration("ttl");
    const renewMs = sessionDuration("renew");
    const session = {
      file: join(deps.configDir, "webchat", "sessions", `${config.bindOperator}.json`),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(renewMs !== undefined ? { renewMs } : {}),
    };
    // Durable chat log (§12.3): <config_dir>/webchat/history/<operator>; the
    // optional history.retain double cap is validated by the §12.2 rules.
    const retainConfig =
      typeof config.history === "object" && config.history !== null
        ? (config.history as { retain?: { age?: string; count?: number } }).retain
        : undefined;
    const history = new HistoryStore({
      dir: join(deps.configDir, "webchat", "history", config.bindOperator),
      operator: config.bindOperator,
      retain: {
        ...(retainConfig?.age !== undefined ? { ageMs: parseRetainAge(retainConfig.age) } : {}),
        ...(retainConfig?.count !== undefined ? { count: retainConfig.count } : {}),
      },
    });
    // Upload caps (§12.5) — validated by the §12.2 rules; connector defaults apply.
    const upload =
      typeof config.upload === "object" && config.upload !== null
        ? (config.upload as { maxBytes?: number; mime?: readonly string[] })
        : undefined;
    const staticDir = resolveUiDist();
    return new WebchatConnector({
      bindOperator: config.bindOperator,
      port,
      password,
      session,
      history,
      blobs: deps.blobs,
      ...(upload !== undefined ? { upload } : {}),
      ...(deps.ports !== undefined ? { ports: deps.ports } : {}),
      ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
      ...(deps.lifecycle !== undefined ? { lifecycle: deps.lifecycle } : {}),
      ...(bind !== undefined ? { bind } : {}),
      ...(basePath !== undefined ? { basePath } : {}),
      ...(staticDir !== undefined ? { staticDir } : {}),
      ...(deps.instanceName !== undefined ? { instanceName: deps.instanceName } : {}),
      // Build info (FR-91): server-side capability, no config — read it here directly.
      serverInfo: buildInfo(),
    });
  }
  throw new Error(`unknown channel type "${config.type}" for "${config.bindOperator}"`);
}
