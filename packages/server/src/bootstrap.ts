// Composition root + minimal boot (§8.2). Start order: load/resolve/validate config
// (§7) → attach agents (attach-miss → down, NOT fatal, FR-7) → start the per-session
// dispatchers. Channel connectors (Phase 8) and the routine scheduler (Phase 7) are
// wired in later; this is the walking skeleton.
//
// The server reaches queue/tmux only through @teamai/orchestrator helpers, so
// @teamai/queue stays orchestrator-only (§8).

import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  type Adapter,
  type AdapterRegistry,
  createDefaultRegistry,
  renderAttribution,
  renderRaw,
} from "@teamai/adapters";
import type { ChannelIdentity } from "@teamai/channels";
import {
  type AgentConfig,
  DEFAULT_PRESENCE_SWEEP_MS,
  DEFAULT_PRESENCE_TTL,
  DEFAULT_RENDEZVOUS_SWEEP_MS,
  type EnvSource,
  type TeamaiConfig,
  type TeardownConfig,
  type UserConfig,
  channelName,
  discoverConfig,
  loadConfigFile,
  resolveRendezvous,
  resolveWipLimit,
  secretValues,
  userRole,
} from "@teamai/config";
import {
  type AgentStatus,
  CommandGrants,
  type Session,
  type SessionAction,
  SessionGrants,
  Topology,
} from "@teamai/core";
import {
  type Reviver,
  type SessionControl,
  captureConsole,
  createReviver,
  reconcileLiveness,
  teardown,
  tmuxSessionControl,
} from "@teamai/lifecycle";
import {
  AgentState,
  Dispatcher,
  type EgressDispatcher,
  type Exchange,
  IdleTeardownSweeper,
  LivenessProbeSweeper,
  PresenceTracker,
  RendezvousCoordinator,
  RendezvousStore,
  ReplyNudger,
  type ResolvedTokenConfig,
  type RetentionHandle,
  type RetentionPolicy,
  type RetentionTarget,
  Router,
  type SessionDriver,
  TmuxSessionDriver,
  type TokenSamplerHandle,
  TokenUsageStore,
  TransportLog,
  buildBroadcastResolver,
  capturePane,
  commandFanout,
  createBlobStore,
  createExchange,
  createFsPauseStore,
  createFsRendezvousStore,
  createRetention,
  ensureSessionQueue,
  fedQueueRoot,
  inFlightId,
  loadSessionDoneIds,
  parseRetainAge,
  probeSession,
  resolveTokenConfig,
  seedPauseRegistry,
  sessionPaths,
  settleExchangeDir,
  startTokenSampler,
  waitForSessionDown,
} from "@teamai/orchestrator";
import { type SchedulerHandle, createFsStateStore, startScheduler } from "@teamai/routines";
import { WebchatConnector, type WebchatLifecycle, type WebchatPorts } from "@teamai/webchat";
import { createBlobsAdmin } from "./admin/blobs";
import { createChannelsAdmin } from "./admin/channels";
import {
  type LifecycleRuntime,
  createLifecycleAdmin,
  resolveIdleTeardownMs,
  resolveRaw,
  resolveTeardown,
} from "./admin/lifecycle";
import { createAdminHandler } from "./admin/plane";
import { type QueueRuntime, createQueuesAdmin } from "./admin/queues";
import { createRoutinesAdmin } from "./admin/routines";
import { createSignalsAdmin } from "./admin/signals";
import { routeExchangeReply } from "./exchange-reply";
import { type AgentPlaneHandle, createAgentPlaneCore, createAgentServer } from "./mcp";
import { OutboxMonitor } from "./outbox";
import { routeRawReply } from "./raw-reply";
import { createTextRedactor } from "./redact";
import { type ServerSurface, startSurface } from "./surface";
import { type ChannelRuntime, type ConnectorFactory, wireChannels } from "./wire-channels";
import { type FederationHandle, buildRouterFederation, wireFederation } from "./wire-federation";
import { type UserRuntime, wireUsers } from "./wire-users";

export interface BootstrapOptions {
  /** Explicit config path; otherwise convention discovery from startDir (§7.4). */
  readonly configFile?: string;
  readonly startDir?: string;
  readonly env?: EnvSource;
  /** Adapter registry; default the built-in (claude). Injectable for tests. */
  readonly registry?: AdapterRegistry;
  /** Attach probe; default tmux has-session. Injectable for tests. */
  readonly probe?: (name: string) => Promise<boolean>;
  /** Session driver factory; default TmuxSessionDriver. Injectable for tests. */
  readonly makeDriver?: (session: Session, adapter: Adapter) => SessionDriver;
  /** Start the dispatcher loops (default true). */
  readonly autoStart?: boolean;
  /** Start the agent-plane MCP listener (default config.server.mcp, §8.1). */
  readonly startMcp?: boolean;
  /** Start the routine scheduler loop (default true, §6/§8.2). */
  readonly startRoutines?: boolean;
  /** Channel connector factory; default the built-in (telegram). Injectable for tests. */
  readonly makeConnector?: ConnectorFactory;
  /** tmux control surface for lifecycle ops (§4); default tmux. Injectable for tests. */
  readonly sessionControl?: SessionControl;
  /** Start the retention sweep loop (default true, §5.4). */
  readonly startRetention?: boolean;
  /** Retention sweep cadence override; default server.cadence.retentionSweepMs ?? 60s (T41). */
  readonly retentionSweepMs?: number;
  /** Start the idle auto-teardown sweep loop (default true, §5.1/FR-92). */
  readonly startIdleTeardown?: boolean;
  /** Idle-teardown clock (test seam); default Date.now. */
  readonly idleTeardownNow?: () => number;
  /** Start the liveness-probe sweep loop (default true, §5.1/FR-93). */
  readonly startLivenessProbe?: boolean;
  /** Start the rendezvous safety-sweep loop (default true, §8.2/FR-105). */
  readonly startRendezvous?: boolean;
}

export interface AgentRuntime {
  readonly name: string;
  readonly session: string;
  readonly state: AgentState;
  readonly dispatcher: Dispatcher;
  /** Lifecycle target context (§4): config + adapter, for the operator-plane. */
  readonly agent: AgentConfig;
  readonly adapter: Adapter;
}

export interface TeamaiServer {
  readonly config: TeamaiConfig;
  readonly router: Router;
  readonly agents: ReadonlyMap<string, AgentRuntime>;
  /**
   * Channel runtimes keyed by their binding: the bound operator in legacy mode
   * (§7.5/FR-37), the channel instance name in users mode (§17.2).
   */
  readonly channels: ReadonlyMap<string, ChannelRuntime>;
  /** User runtimes (§17.5, FR-124): pseudo-session egress + history, by name. */
  readonly users: ReadonlyMap<string, UserRuntime>;
  /** User presence (§17.5, FR-133) — derived from outgoing traffic. */
  readonly presence: PresenceTracker;
  readonly warnings: readonly string[];
  /** The MCP agent-plane endpoint, when server.mcp is on (§8.1); else undefined. */
  readonly agentPlane?: AgentPlaneHandle;
  /** Operator-plane HTTP-admin endpoint (§8.5), loopback-only. */
  readonly adminUrl: string;
  /**
   * The operator-plane handler, callable in-process (tests; the network path goes
   * through the surface, which adds the loopback gate — surface.ts).
   */
  readonly adminFetch: (req: Request) => Promise<Response>;
  /** Retention sweep handle (§5.4); sweep() runs one prune+GC pass on demand. */
  readonly retention: RetentionHandle;
  /** Idle auto-teardown sweeper (§5.1/FR-92); present when any agent opts in. */
  readonly idleTeardown?: IdleTeardownSweeper;
  /** Liveness-probe sweeper (§5.1/FR-93); reconciles status vs live tmux, on demand via tick(). */
  readonly liveness?: LivenessProbeSweeper;
  /** Rendezvous coordinator (§8.2/FR-105); present unless disabled — sweep() on demand. */
  readonly rendezvous?: RendezvousCoordinator;
  /** Federation runtime (§18, FR-137…FR-146); present when the config federates. */
  readonly federation?: FederationHandle;
  status(name: string): AgentStatus | undefined;
  stop(): Promise<void>;
}

// §5.4 thresholds (T41-calibrated defaults — the §7.1 sample values).
const DEFAULT_RETAIN_AGE = "7d";
const DEFAULT_RETAIN_COUNT = 1000;

function retentionPolicy(retain: { age?: string; count?: number } | undefined): RetentionPolicy {
  return {
    ageMs: parseRetainAge(retain?.age ?? DEFAULT_RETAIN_AGE),
    count: retain?.count ?? DEFAULT_RETAIN_COUNT,
  };
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<TeamaiServer> {
  // 1. config (§7): discover → load → validate with the registry's known types.
  const discoverOptions: { explicitPath?: string; startDir?: string } = {};
  if (options.configFile !== undefined) discoverOptions.explicitPath = options.configFile;
  if (options.startDir !== undefined) discoverOptions.startDir = options.startDir;
  const location = discoverConfig(discoverOptions);
  // The validation-time registry only contributes its type names; the render-time
  // one (below) additionally knows the blob dir, which needs the queue root —
  // which needs the validated config. Same types either way.
  const probeRegistry = options.registry ?? createDefaultRegistry({ stateDir: location.stateDir });
  const loaded = loadConfigFile(location.configFile, {
    knownAdapterTypes: probeRegistry.types(),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const config = loaded.config;

  // 2. queue root (§5.3): server.queueDir overrides the default, resolved vs config_dir.
  const root =
    config.server.queueDir !== undefined
      ? resolve(location.configDir, config.server.queueDir)
      : location.queueDir;
  // Blob refs render to agents as local paths under <root>/blobs/ (FR-43, §12.5).
  const registry =
    options.registry ??
    createDefaultRegistry({ stateDir: location.stateDir, blobsDir: join(root, "blobs") });

  // 3. participants → queue keys (§7.5): agent→tmux, operator→name, user→name
  //    (§17.2 — one pseudo-session per user whatever the number of channels).
  const operatorNames = [
    ...new Set(
      config.channels.flatMap((channel) =>
        channel.bindOperator !== undefined ? [channel.bindOperator] : [],
      ),
    ),
  ];
  const userConfigs: readonly UserConfig[] = config.users ?? [];
  const userByName = new Map(userConfigs.map((user) => [user.name, user]));
  const isUser = (name: string): boolean => userByName.has(name);
  const agentTmuxByName = new Map(config.agents.map((agent) => [agent.name, agent.tmux]));
  const queueKeyOf = (name: string): string | null => {
    const tmux = agentTmuxByName.get(name);
    if (tmux !== undefined) return tmux;
    if (userByName.has(name)) return name;
    return operatorNames.includes(name) ? name : null;
  };
  // WIP limits (§8.2 backpressure, FR-104): resolve each agent's effective cap
  // (agent → server → default 3); `0` means unlimited. wipLimitOf returns the cap
  // for a gated agent, or null (EXEMPT) for a `0`-limit agent (a hub set to 0),
  // an operator, or an unknown name — reachability of operators/hub is never
  // throttled. Only agents with a positive cap are gated at route time.
  const wipLimitByAgent = new Map(
    config.agents.map((agent) => [agent.name, resolveWipLimit(agent, config.server)]),
  );
  const wipLimitOf = (name: string): number | null => {
    const limit = wipLimitByAgent.get(name);
    return limit !== undefined && limit > 0 ? limit : null;
  };
  // Agent pause (§16, FR-116): rehydrate the operator-declared do-not-disturb set
  // from state/paused.json — a declared refusal must not be silently undone by a
  // restart (§16.4). A name that is no longer a configured agent is dropped with a
  // warning; only agents can be paused (operators/groups/tags never are, §16.1), so
  // the predicate below answers false for every non-agent name by construction.
  // A USER can be paused too (§17.8, FR-134 — DND), and the registry is shared:
  // the namespace is disjoint (§10.17), so one file holds both kinds (§16.4).
  const pauseStore = createFsPauseStore(location.stateDir);
  const isPausableNode = (name: string): boolean => agentTmuxByName.has(name) || isUser(name);
  const { registry: pauseRegistry, dropped: droppedPauses } = seedPauseRegistry(
    await pauseStore.read(),
    isPausableNode,
  );
  for (const name of droppedPauses) {
    process.stderr.write(
      `teamai: warning: dropping the persisted pause of "${name}" — no such agent or user in the config (§16.4)\n`,
    );
  }
  const isPaused = (name: string): boolean => pauseRegistry.has(name);
  const pausePort = {
    has: isPaused,
    set: (name: string, paused: boolean): boolean => pauseRegistry.set(name, paused),
    persist: (): Promise<void> => pauseStore.write(pauseRegistry.snapshot()),
  };

  // 4. ensure every participant's queue exists (routing to a down agent / not-yet-
  //    connected operator just accumulates, NFR-4).
  for (const agent of config.agents) await ensureSessionQueue(root, agent.tmux);
  for (const operator of operatorNames) await ensureSessionQueue(root, operator);
  for (const user of userConfigs) await ensureSessionQueue(root, user.name); // §17.2
  // Shared blob store <root>/blobs/ (§5.3): exchange replies (FR-54), operator
  // uploads (FR-46) and channels all write through the same tmp+rename path.
  const blobs = await createBlobStore(root);

  // 5. router (§8.2) — the single delivery point — plus the reply-nudge ledger
  //    (FR-45, T58): the router reports every routed send, agent dispatchers mark
  //    turn windows, and a reply-less operator message earns one nudge. The
  //    `router` reference inside the nudger's closure resolves at call time.
  const operatorSet = new Set(operatorNames);
  const topology = new Topology(config.topology);
  // Broadcast resolver (§15.4, FR-110): classifies a `to` as a group/tag and resolves
  // its member agents (hierarchical for groups, carriers for tags). Fed to the router
  // so a broadcast fans out in the single delivery point. Membership is fixed at boot.
  // Users are equal members of a group/tag (§17.5, FR-130) — they join the same
  // resolver, so a broadcast reaches them as a copy into their pseudo-session.
  const resolveBroadcast = buildBroadcastResolver(config.groups ?? [], [
    ...config.agents,
    ...userConfigs,
  ]);
  // Presence (§17.5, FR-133): derived from the router's outgoing traffic.
  const presence = new PresenceTracker({
    ttlMs: parseRetainAge(config.server.presenceTtl ?? DEFAULT_PRESENCE_TTL),
  });
  const nudger = new ReplyNudger({
    isOperator: (name) => operatorSet.has(name),
    route: (message) => router.route(message),
  });
  // Transport log (FR-48, §8.2): the router is the single delivery point, so
  // EVERY routed signal lands in <root>/observe/transport.jsonl. Off the hot
  // path: append never throws and is not awaited by route(). History-style
  // defaults (§12.3 spirit) — the log outlives the done/ window.
  const transportLog = new TransportLog({ root });
  // Token accounting (§12.8, FR-103): one in-memory store; per-agent resolved
  // config (durations→ms, defaults) for the types that opt in. The sampler is
  // started after the agents map + peerStatus exist (step 7).
  const tokenStore = new TokenUsageStore();
  const tokenConfigs = new Map<string, ResolvedTokenConfig>();
  for (const agent of config.agents) {
    const resolved = resolveTokenConfig(config.types?.[agent.type]?.tokens);
    if (resolved !== undefined) tokenConfigs.set(agent.name, resolved);
  }
  let tokenSampler: TokenSamplerHandle | undefined;
  // Idle auto-teardown (FR-92, §5.1): assigned after the agents loop (it needs the
  // runtimes); the router's onRouted feeds it the activity clock — a routed
  // message to/from an eligible agent resets its inactivity window (§8.2).
  let idleSweeper: IdleTeardownSweeper | undefined;
  // Liveness probe (FR-93, §5.1): assigned after the agents loop — reconciles every
  // agent's status with its live tmux session so a hand start/kill is reflected
  // without a restart. Always wired (universal reconcile), unlike idle-teardown.
  let livenessSweeper: LivenessProbeSweeper | undefined;
  // Rendezvous coordinator (§8.2, FR-105): a WIP strike (onRefused) registers an
  // intent; the sweep later notifies the idle sender's TARGET past its WIP gate
  // (direction S). Built BEFORE the router so its hooks can reference the coordinator;
  // its own `route`/`statusOf` closures resolve `router`/`agents` at call time (like
  // the nudger). Skipped entirely when `server.rendezvous.enabled` is false.
  const resolvedRendezvous = resolveRendezvous(config.server);
  let rendezvous: RendezvousCoordinator | undefined;
  if (resolvedRendezvous.enabled) {
    rendezvous = new RendezvousCoordinator({
      store: new RendezvousStore(),
      persist: createFsRendezvousStore(location.stateDir),
      route: (message, opts) => router.route(message, opts),
      statusOf: (name) => agents.get(name)?.state.status, // agents only (operators ⇒ undefined)
      windowMs: parseRetainAge(resolvedRendezvous.window),
      maxAttempts: resolvedRendezvous.maxAttempts,
      sweepIntervalMs: config.server.cadence?.rendezvousSweepMs ?? DEFAULT_RENDEZVOUS_SWEEP_MS,
    });
  }
  // Federation ports (§18.5, §10.26): config + journal knowledge, built BEFORE
  // the router so an FQN `to` routes into a link queue and link ingress passes
  // the owner's gates in the same single point. Undefined without federation.
  const routerFederation = buildRouterFederation(config, transportLog);
  const router = new Router({
    topology,
    root,
    queueKeyOf,
    wipLimitOf,
    // Pause gate (§16.2, FR-117) — checked after the edge, before the WIP cap.
    isPaused,
    // DND (§17.8, FR-134): a paused USER still receives their own notes.
    isUser,
    resolveBroadcast,
    ...(routerFederation !== undefined ? { federation: routerFederation } : {}),
    onRouted: (message) => {
      // Presence (§17.5, FR-133): the single delivery point sees every producer,
      // so one hook covers the panel, the channels and self-delivery alike.
      if (isUser(message.from)) presence.note(message.from);
      nudger.recordSend(message.from, message.to);
      void transportLog.append(message);
      idleSweeper?.noteActivity(message.from);
      idleSweeper?.noteActivity(message.to);
      rendezvous?.onRouted(message); // accepted counter-send B→A resolves an intent (FR-105)
    },
    onRefused: (message, info) => rendezvous?.onRefused(message, info), // WIP strike → intent (FR-105)
  });

  // 6. attach agents + start dispatchers (one per session).
  const probe = options.probe ?? probeSession;
  const autoStart = options.autoStart ?? true;
  const abort = new AbortController();
  const runs: Promise<void>[] = [];
  const agents = new Map<string, AgentRuntime>();
  // Auto-revive (FR-50/FR-51, §5.1): one Reviver per provision-configured agent —
  // it owns the "once per down-episode, with a stop" budget. Shared by the startup
  // attempt (auto: true), the dispatcher's lazy reviveDown, and the operator-plane
  // onUp reset, so all three see the same budget.
  const sessionControl = options.sessionControl ?? tmuxSessionControl;
  const revivers = new Map<string, Reviver>();
  // File exchange (§13, FR-52): one per agent — the universal agent-side protocol.
  const exchanges = new Map<string, Exchange>();

  // NFR-10 cadences (T41-calibrated defaults, overridable via server.cadence §7.1).
  const cadence = config.server.cadence ?? {};

  for (const agent of config.agents) {
    const session: Session = { name: agent.tmux };
    const adapter = registry.get(agent.type);
    const up = await probe(agent.tmux); // attach: live → idle, miss → down (not fatal, FR-7)
    const state = new AgentState(up ? "idle" : "down");
    const reviver =
      agent.provision !== undefined
        ? createReviver(
            { agent, adapter, state },
            {
              control: sessionControl,
              configDir: location.configDir,
              onError: (error) =>
                process.stderr.write(
                  `teamai: warning: auto-provision of "${agent.name}" failed: ${
                    error instanceof Error ? error.message : String(error)
                  }\n`,
                ),
            },
          )
        : undefined;
    if (reviver !== undefined) revivers.set(agent.name, reviver);
    // FR-50: provision.auto → ONE startup attempt on attach-miss. Failure is a
    // warning (onError above), never fatal — exactly like the attach-miss itself.
    if (!up && agent.provision?.auto === true && reviver !== undefined) {
      await reviver.revive();
    }
    // File exchange (§13.1): explicit exchangeDir → <cwd>/.teamai → <root>/<session>/exchange,
    // settled to its realpath (FR-83) — the §13.2 hint must match the agent's view.
    const exchange = createExchange({
      dir: await settleExchangeDir({
        ...(agent.exchangeDir !== undefined ? { exchangeDir: agent.exchangeDir } : {}),
        ...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
        configDir: location.configDir,
        root,
        session: agent.tmux,
      }),
      // file-detect (FR-53) polls on the same cadence as output detection (NFR-10)
      ...(cadence.outputPollMs !== undefined ? { pollIntervalMs: cadence.outputPollMs } : {}),
    });
    exchanges.set(agent.name, exchange);
    // Cleanup discipline (T75, live finding): the turn dir is removed only after
    // a SUCCESSFUL collection. An agent that breaks the contract order (deletes
    // message.json before writing reply.md) keeps working in that dir after the
    // turn ends — destroying it mid-flight loses the late files without a trace.
    // Uncollected dirs go to the orphan sweep instead (§5.4). One dispatcher per
    // session (§10.8) → turns are sequential → a plain flag is race-free.
    let collectedThisTurn = false;
    // Raw mode (FR-88, §14): the resolved capture rule (agent.raw ?? type.raw,
    // default stabilize-and-capture) and the lifecycle target captureConsole
    // needs. A raw turn skips the exchange and the nudge entirely (below).
    const rawRule = resolveRaw(agent, config.types);
    const rawTarget = { agent, adapter, state };
    const driver = options.makeDriver
      ? options.makeDriver(session, adapter)
      : new TmuxSessionDriver({
          session,
          adapter,
          ...(cadence.outputPollMs !== undefined ? { pollIntervalMs: cadence.outputPollMs } : {}),
        });
    const dispatcher = new Dispatcher({
      paths: sessionPaths(root, agent.tmux),
      driver,
      // The pause hold (§16.3, FR-118): while paused this loop injects nothing —
      // no dequeue, no cur/ re-send, no lazy revive. A running turn still finishes,
      // and the control lane keeps draining (commands/lifecycle stay available).
      isPaused: () => isPaused(agent.name),
      // Raw mode (FR-88, §14.1): the operator's text reaches the terminal
      // verbatim — no attribution/exchange wrapping; otherwise the normal render.
      render: (message, ctx) =>
        message.raw === true ? renderRaw(message) : adapter.render(message, ctx),
      state,
      doneIds: await loadSessionDoneIds(root, agent.tmux),
      ...(cadence.outputPollMs !== undefined ? { pollIntervalMs: cadence.outputPollMs } : {}),
      awaitDown: (signal) =>
        waitForSessionDown(agent.tmux, signal, {
          hasSession: probe,
          ...(cadence.downProbeMs !== undefined ? { intervalMs: cadence.downProbeMs } : {}),
        }),
      // Reply-nudge window (FR-45) + console-fallback scrape (FR-47): agent
      // dispatchers only — the operator egress pseudo-session never nudges (§8.2).
      // A raw turn opens no window (its reply is the captured console, FR-88).
      beforeInject: (message) => {
        if (message.raw === true) return;
        nudger.beginTurn(agent.name, message);
      },
      afterTurn: async (message) => {
        reviver?.noteDone(); // a done/ turn — proof of progress re-arms auto-revive (FR-51)
        // Raw mode (FR-88, §14.2): the reply IS the console — capture it as-is by
        // the configured rule and route it back; no exchange/scrape/nudge chain.
        if (message.raw === true) {
          await routeRawReply(message, {
            agent: agent.name,
            capture: () =>
              captureConsole(rawTarget, {
                control: sessionControl,
                ...(rawRule !== undefined ? { raw: rawRule } : {}),
              }),
            route: (reply) => router.route(reply),
          });
          return;
        }
        // File-borne reply FIRST (FR-54, §13.3): a routed reply closes the
        // nudge window, so the scrape/nudge chain below stays silent.
        collectedThisTurn = await routeExchangeReply(message, {
          agent: agent.name,
          exchange,
          blobs,
          route: (reply) => router.route(reply),
        });
        return nudger.afterTurn(
          agent.name,
          message,
          adapter.extractReply === undefined
            ? undefined
            : async () => {
                // Scrape needs scrollback — a long answer leaves the visible screen.
                const pane = await capturePane(agent.tmux, { historyLines: 500 });
                return adapter.extractReply?.(pane, renderAttribution(message)) ?? null;
              },
        );
      },
      // Lazy auto-revive (FR-51): a down session with queued work gets one
      // budget-gated attempt from its own dispatcher loop.
      ...(reviver !== undefined
        ? {
            reviveDown: async (): Promise<void> => {
              await reviver.revive();
            },
          }
        : {}),
      // File exchange (§13, FR-52): inbox materialization at claim + turn
      // cleanup — gated on a successful collection (T75, see flag above).
      exchange: {
        materialize: (message) => {
          collectedThisTurn = false; // a fresh turn
          // Raw mode (FR-88): no inbox projection — the dispatcher renders
          // verbatim and skips file-detect (null ⇒ no message.json this turn).
          if (message.raw === true) return Promise.resolve(null);
          return exchange.materialize(message);
        },
        awaitDone: (message, signal) => exchange.awaitDone(message, signal),
        cleanup: async (message) => {
          if (!collectedThisTurn) return; // uncollected → the orphan sweep's (§5.4)
          await exchange.cleanup(message);
        },
      },
    });
    agents.set(agent.name, {
      name: agent.name,
      session: agent.tmux,
      state,
      dispatcher,
      agent,
      adapter,
    });
    if (autoStart) runs.push(dispatcher.run(abort.signal));

    // Outbox monitor (FR-55, §13.4): agent initiative without MCP — one pickup
    // loop per agent over <exchange>/outbox/, routed as the folder's owner.
    const outbox = new OutboxMonitor({
      agent: agent.name,
      outboxDir: exchange.outboxDir,
      containRoots: [exchange.dir, ...(agent.cwd !== undefined ? [agent.cwd] : [])],
      filesBase: agent.cwd ?? exchange.dir,
      blobs,
      // Agent initiative with no recipient (§17.11, FR-135): fan out to the users
      // with `role:"admin"` — the humans who work the consoles directly.
      admins: () =>
        userConfigs.filter((user) => userRole(user) === "admin").map((user) => user.name),
      route: (message) => router.route(message),
      ...(cadence.outboxPollMs !== undefined ? { pollIntervalMs: cadence.outboxPollMs } : {}),
    });
    if (autoStart) runs.push(outbox.run(abort.signal));
  }

  // 7. agent-plane (§8.1): MCP on server.port, identity-bound (§8.6). Gated by
  //    server.mcp; mcp:false → no external listener, only operator-plane/channels.
  // A user has no session, so no status (§17.5) — presence answers "are they
  // around" instead (FR-133); `list_peers` reports it separately.
  const peerStatus = (name: string): AgentStatus | undefined =>
    agents.get(name)?.state.status ?? (operatorSet.has(name) ? "idle" : undefined);
  const isKnownIdentity = (name: string): boolean =>
    agents.has(name) || operatorSet.has(name) || isUser(name);

  // Token sampler (§12.8, FR-103): drives tokenStore for the opted-in agents. Reads
  // the agents map each tick (picks up provisioning), skips down agents, persists
  // under <configDir>/state/tokens. Tied to the shutdown abort; stopped explicitly
  // for a final flush.
  if (tokenConfigs.size > 0) {
    tokenSampler = startTokenSampler({
      store: tokenStore,
      agents: () =>
        [...tokenConfigs.entries()].flatMap(([name, cfg]) => {
          const runtime = agents.get(name);
          return runtime === undefined ? [] : [{ name, session: runtime.session, config: cfg }];
        }),
      status: peerStatus,
      capture: (session) => capturePane(session),
      stateDir: join(location.configDir, "state", "tokens"),
      signal: abort.signal,
    });
  }

  // Agent→agent command ACL (FR-94/FR-95, §7.1). The command runner is forward-wired
  // once lifecycleAdmin exists (step 8); MCP connections only open after the surface
  // starts (step 9), so it is always set before send_command/list_commands run.
  const commandGrants = new CommandGrants(config.commandGrants ?? {});
  let commandPort:
    | { list(name: string): readonly string[]; run(name: string, slash: string): Promise<string> }
    | undefined;
  // Agent→agent session-control ACL (FR-96/FR-97, §7.1). The control runner is
  // forward-wired the same way commandPort is — once lifecycleAdmin exists (step 8).
  const sessionGrants = new SessionGrants(config.sessionGrants ?? {});
  let sessionPort:
    | {
        catalog(name: string): readonly SessionAction[];
        run(name: string, action: SessionAction): Promise<AgentStatus>;
      }
    | undefined;

  // Steps 7–10 run with the dispatcher loops already live: a throw here (e.g. an
  // unknown channel type, a busy port) must abort them, or a failed boot leaks
  // running loops.
  let surface: ServerSurface | undefined;
  let adminHandler: ((req: Request) => Promise<Response>) | undefined;
  let channelsHandle: Awaited<ReturnType<typeof wireChannels>> | undefined;
  let usersHandle: Awaited<ReturnType<typeof wireUsers>> | undefined;
  // Federation (§18): wired in step 8c, but the MCP/webchat closures below read it
  // lazily — the same forward-wiring pattern commandPort/sessionPort use.
  let federationHandle: FederationHandle | undefined;
  let scheduler: SchedulerHandle | undefined;
  let retention: RetentionHandle | undefined;
  try {
    // 7. agent-plane core (§8.1): MCP, identity-bound (§8.6). Gated by server.mcp;
    //    mcp:false → no /mcp mount, only operator-plane/channels. No listener yet —
    //    both planes share the surface started in step 9 (§8.1).
    const mcpCore =
      (options.startMcp ?? config.server.mcp)
        ? createAgentPlaneCore({
            isKnownIdentity,
            makeServer: (caller) =>
              createAgentServer(caller, {
                topology,
                router,
                peerStatus,
                // Pause, read-only for agents (§16.5, FR-119): a caller sees that a
                // neighbour is paused; setting it stays operator-only (§10.10).
                peerPaused: isPaused,
                // Peer kind (§15.5, FR-111): a group/tag is derived from the same
                // resolver the router fans out with; a configured human is a "user"
                // (§17.5) and anything else — the legacy operator included — an "agent".
                peerType: (name) =>
                  resolveBroadcast(name)?.kind ?? (isUser(name) ? "user" : "agent"),
                // Presence of a user peer (§17.5, FR-133) — instead of a status.
                peerPresence: (name) => (isUser(name) ? presence.presence(name) : undefined),
                // get_history (T126, FR-87): the pair's dialogue out of the
                // transport log (§8.2) — read-only, neighbor-scoped in the tool.
                pairHistory: (me, peer, limit) => transportLog.pair(me, peer, limit),
                // get_screen (T214, FR-147): a NEIGHBOUR's console as text — the
                // same capture the panel's Screen Live shows (FR-102), through the
                // same read-only path (no lane, no injection — §10.8). The edge is
                // re-checked here as well as in the tool: the port must not be a
                // wider capability than the tool that fronts it. The text is
                // scrubbed of resolved $env secrets (§8.7/NFR-6) — a console can
                // have echoed one, and this hands it to ANOTHER agent.
                screen: async (name, historyLines) => {
                  const runtime = agents.get(name);
                  if (runtime === undefined || !topology.neighbors(caller).includes(name)) {
                    throw new Error(`unknown agent "${name}"`);
                  }
                  const text = await capturePane(
                    runtime.session,
                    historyLines !== undefined && historyLines > 0 ? { historyLines } : {},
                  );
                  return redactText(text);
                },
                // Agent→agent commands (FR-94/FR-95): the ACL gates, the runner is
                // the same control-lane path the operator uses (lifecycleAdmin).
                commandGrants,
                listCommands: (name) => commandPort?.list(name) ?? [],
                runCommand: (name, slash) => {
                  if (commandPort === undefined) throw new Error("command port not wired");
                  return commandPort.run(name, slash);
                },
                // Agent→agent session control (FR-96/FR-97): the ACL gates, the
                // runner is the same lifecycle path the operator uses (lifecycleAdmin).
                sessionGrants,
                listControls: (name) => sessionPort?.catalog(name) ?? [],
                controlSession: (name, action) => {
                  if (sessionPort === undefined) throw new Error("session port not wired");
                  return sessionPort.run(name, action);
                },
                // Federated peers (§18.4, FR-140/FR-150): an edge on an import
                // node opens ALL its actors (§18.10-6); the projection comes from
                // the registry — read-only, `unknown` when the source is dark.
                remotePeers: () =>
                  federationHandle === undefined
                    ? []
                    : topology
                        .neighbors(caller)
                        .flatMap((node) => federationHandle?.peersOf(node) ?? []),
              }),
            // Takeover (FR-44b) is normal after an agent restart but also the trace
            // of a duplicate-name misconfiguration — always surfaced.
            onEviction: (name, oldSession) =>
              process.stderr.write(
                `teamai: warning: identity "${name}" taken over by a new session (evicted ${oldSession}, FR-44b)\n`,
              ),
          })
        : undefined;

    // 8. channels (§8.2 start order: dispatchers → connectors → routines, FR-37):
    //    one egress dispatcher per operator pseudo-session, the connector's deliver
    //    port injected on its start; pre-registration pending/ drains then (NFR-4).
    // Webchat read-only dynamics ports (§12.4, FR-40): neighbor-scoped peer list
    // (§10.2), live status, and queue OBSERVATION via readdir — never mutation
    // (§10.8). Injected like deliver/router.route, so the §8 graph stays acyclic.
    const countJson = async (dir: string): Promise<number> => {
      try {
        return (await readdir(dir)).filter((f) => f.endsWith(".json")).length;
      } catch {
        return 0;
      }
    };
    const groupByName = new Map((config.groups ?? []).map((g) => [g.name, g]));
    const allTagNames = [...new Set(config.agents.flatMap((a) => a.tags ?? []))];
    const makePorts = (operator: string): WebchatPorts => ({
      // Peers with a chat (§10.2): agents and — since §17.7 (FR-129) — user peers.
      listPeers: () =>
        topology.neighbors(operator).filter((name) => agents.has(name) || isUser(name)),
      peerStatus,
      // Pause marker (§16.6, FR-119/FR-120) — beside the status, not inside it.
      peerPaused: isPaused,
      // Broadcast surface (§15, FR-112): a peer's kind + an agent's group/tags for the
      // sidebar tree, and the operator's group/tag neighbors with resolved members.
      // A user peer reports "user" (§17.7): no console, no lifecycle, presence dot.
      peerType: (name) => resolveBroadcast(name)?.kind ?? (isUser(name) ? "user" : "agent"),
      peerPresence: (name) => (isUser(name) ? presence.presence(name) : undefined),
      peerDisplayName: (name) => userByName.get(name)?.displayName,
      agentGroup: (name) => agents.get(name)?.agent.group ?? userByName.get(name)?.group,
      agentTags: (name) => agents.get(name)?.agent.tags ?? userByName.get(name)?.tags ?? [],
      broadcastPeers: () => {
        const neighbors = new Set(topology.neighbors(operator));
        const groups = (config.groups ?? [])
          .filter((g) => neighbors.has(g.name))
          .map((g) => {
            const parent = groupByName.get(g.name)?.parent;
            return {
              name: g.name,
              type: "group" as const,
              ...(parent !== undefined ? { parent } : {}),
              members: resolveBroadcast(g.name)?.members ?? [],
            };
          });
        const tags = allTagNames
          .filter((t) => neighbors.has(t))
          .map((t) => ({
            name: t,
            type: "tag" as const,
            members: resolveBroadcast(t)?.members ?? [],
          }));
        return [...groups, ...tags];
      },
      // configured UI accent (FR-73, §7.1); absent ⇒ the panel picks from its palette
      peerColor: (name) => agents.get(name)?.agent.color ?? userByName.get(name)?.color,
      queueDepth: async (name) => {
        const runtime = agents.get(name);
        if (runtime === undefined) return 0;
        const paths = sessionPaths(root, runtime.session);
        return (await countJson(paths.pending)) + (await countJson(paths.cur));
      },
      messagePhase: async (name, id) => {
        const runtime = agents.get(name);
        if (runtime === undefined) return undefined;
        const paths = sessionPaths(root, runtime.session);
        const suffix = `-${id}.json`; // file name <unix_ms>-<seq>-<id>.json (§5.3)
        for (const phase of ["cur", "pending", "done", "failed"] as const) {
          try {
            if ((await readdir(paths[phase])).some((f) => f.endsWith(suffix))) return phase;
          } catch {
            // session queue not created yet
          }
        }
        return undefined;
      },
      // token-usage series (§12.8, FR-103); undefined for a type without accounting
      tokenSeries: (name) => {
        const cfg = tokenConfigs.get(name);
        if (cfg === undefined || !agents.has(name)) return undefined;
        return { ...tokenStore.series(name, Date.now()), maxThreshold: cfg.maxThreshold };
      },
      // WIP cap (§8.2, FR-104) + rendezvous view (FR-105) for the panel markers.
      wipLimitOf,
      rendezvousState: () => rendezvous?.rendezvousState() ?? { waiting: [], awaited: [] },
      // Federated peers (§18.4, FR-144/FR-150): same edge rule as agents — the
      // viewer needs an edge on the import node; rows are read-only projections.
      remotePeers: () =>
        federationHandle === undefined
          ? []
          : topology.neighbors(operator).flatMap((node) => federationHandle?.peersOf(node) ?? []),
    });

    // Lifecycle runtimes + admin BEFORE the channels: the webchat panel gets a
    // NARROW lifecycle port (T85, FR-65) — shutdown/reload of the operator's
    // topology neighbors only, a deliberate §10.12 capability extension; the
    // full operator-plane (§8.5) stays unreachable from the panel.
    const lifecycleRuntimes = new Map<string, LifecycleRuntime>(
      [...agents.values()].map((runtime) => {
        const reviver = revivers.get(runtime.name);
        return [
          runtime.name,
          {
            name: runtime.name,
            target: { agent: runtime.agent, adapter: runtime.adapter, state: runtime.state },
            lane: runtime.dispatcher.control,
            // Operator provision/restart re-arms the auto-revive budget (FR-51).
            ...(reviver !== undefined ? { onUp: () => reviver.reset() } : {}),
          },
        ];
      }),
    );
    const lifecycleAdmin = createLifecycleAdmin({
      agents: lifecycleRuntimes,
      control: sessionControl,
      configDir: location.configDir,
      ...(config.types !== undefined ? { types: config.types } : {}),
      // Pause (§16.5, FR-119): the operator's mutation surface over the same
      // registry the router and the dispatchers read. Users join it as DND
      // (§17.8, FR-134) — same registry, same file, no session involved.
      pausableUsers: new Set(userConfigs.map((user) => user.name)),
      pause: pausePort,
    });
    // Forward-wire the agent-plane command port (FR-94/FR-95) now that the runner
    // exists — the SAME control-lane path the operator/webchat use, the catalog IS
    // the allowlist (FR-66/FR-67), the commandGrants ACL gates the caller upstream.
    // A "*" recipient grant can make an operator a list_commands target (operators
    // are topology neighbors too); they have no console/catalog, so answer empty
    // rather than throwing UNKNOWN_AGENT. send_command's own try/catch turns the
    // same case into COMMAND_FAILED for a non-agent recipient.
    commandPort = {
      list: (name) =>
        agents.has(name) ? lifecycleAdmin.commands(name).map((command) => command.slash) : [],
      run: (name, slash) => lifecycleAdmin.command(name, slash),
    };
    // Forward-wire the agent-plane session-control port (FR-96/FR-97) — the SAME
    // lifecycle path the operator/webchat use, the sessionGrants ACL gates the caller
    // upstream. The applicable catalog mirrors the webchat actions() logic: stop and
    // shutdown work on any session; start/restart/reload need a provision command to
    // come back up. A non-agent recipient (e.g. an operator reached via a "*" grant)
    // has no session → empty catalog; control_session's own try/catch turns the run
    // into CONTROL_FAILED for that case.
    sessionPort = {
      catalog: (name) => {
        const runtime = agents.get(name);
        if (runtime === undefined) return [];
        return runtime.agent.provision?.command !== undefined
          ? (["start", "stop", "shutdown", "restart", "reload"] as const)
          : (["stop", "shutdown"] as const);
      },
      run: (name, action) => {
        switch (action) {
          case "start":
            return lifecycleAdmin.provision(name);
          case "stop":
            return lifecycleAdmin.kill(name);
          case "shutdown":
            return lifecycleAdmin.shutdown(name);
          case "restart":
            return lifecycleAdmin.restart(name);
          case "reload":
            return lifecycleAdmin.reload(name);
        }
      },
    };
    // §8.7/NFR-6: scrub every operator-facing error of resolved $env secrets.
    // Built here (before the webchat lifecycle port) so the panel command-fanout
    // can redact per-agent failure text too; reused by the admin plane below.
    const redactText = createTextRedactor(secretValues(config, loaded.secretPaths));
    const makeLifecycle = (operator: string): WebchatLifecycle => ({
      actions: (name) => {
        // A user peer (§17.7): no session to shut down or reload — the only action
        // is DND, and only for oneself or for an admin (§17.8, FR-134). The panel
        // gates the admin case; here the capability is simply "pause is possible".
        if (isUser(name)) {
          const viewer = userByName.get(operator);
          const mayPause =
            name === operator || (viewer !== undefined && userRole(viewer) === "admin");
          return { shutdown: false, reload: false, pause: mayPause };
        }
        const runtime = agents.get(name);
        if (runtime === undefined || !topology.neighbors(operator).includes(name)) {
          return { shutdown: false, reload: false, pause: false };
        }
        return {
          // a live session to tear down; reload additionally needs a way back up
          shutdown: runtime.state.status !== "down",
          reload: runtime.agent.provision?.command !== undefined,
          // Pause needs no session (§16.6, FR-120) — a transport flag, available on
          // an idle, busy or down neighbour alike.
          pause: true,
        };
      },
      shutdown: (name) => lifecycleAdmin.shutdown(name),
      reload: (name) => lifecycleAdmin.reload(name),
      // Pause / resume of a NEIGHBOUR (§16.5, FR-119): the §10.12 capability set
      // grows by a strictly weaker action than the shutdown it already had.
      pause: (name, paused) => lifecycleAdmin.pause(name, paused),
      // slash commands: merged type ∪ agent config list (FR-66) + internal
      // commands (FR-67, e.g. /screenshot — every agent); the list IS the
      // allowlist — runCommand refuses anything outside it
      // A user peer (§17.7) has no console at all, so it has no command catalog —
      // asking the lifecycle admin for one would (rightly) raise UNKNOWN_AGENT.
      commands: (name) =>
        agents.has(name) && topology.neighbors(operator).includes(name)
          ? lifecycleAdmin.commands(name).map((command) => command.slash)
          : [],
      runCommand: (name, slash) => lifecycleAdmin.command(name, slash),
      // Slash-command to a selector INTERSECTION (§15.8, FR-115): resolve against
      // the full config, but dispatch ONLY to agents that are this operator's
      // topology neighbours (§10.2) — a non-neighbour in the intersection comes
      // back COMMAND_DENIED rather than being reached. Per-agent failure text is
      // scrubbed (§8.7); a failure never sinks the fan-out (§10.18).
      commandFanout: (slash, selectors) =>
        commandFanout(slash, selectors, {
          resolveBroadcast,
          isAgent: (name) => agents.has(name),
          dispatchOne: async (agent, command) => {
            if (!topology.neighbors(operator).includes(agent)) {
              return {
                to: agent,
                ok: false,
                code: "COMMAND_DENIED",
                output: "not a topology neighbour",
              };
            }
            try {
              return { to: agent, ok: true, output: await lifecycleAdmin.command(agent, command) };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              return { to: agent, ok: false, code: "COMMAND_FAILED", output: redactText(reason) };
            }
          },
        }),
      // Live console snapshot (FR-102): the neighbor's VISIBLE pane as-is —
      // read-only, no lane/mutation. Same neighbor gate as commands (§10.2).
      screen: (name) => {
        const runtime = agents.get(name);
        if (runtime === undefined || !topology.neighbors(operator).includes(name)) {
          throw new Error(`unknown agent "${name}"`);
        }
        return capturePane(runtime.session);
      },
    });

    // 8a. users (§17.5, FR-124): one pseudo-session egress each, its sink writing
    //     the user's history and fanning a best-effort push out over every bound
    //     channel. Wired BEFORE the channels so a connector can register itself as
    //     a push target the moment it starts (§8.2 start order).
    const webchatChannel = config.channels.find((channel) => channel.type === "webchat");
    const historyRetain = (
      webchatChannel?.history as { retain?: { age?: string; count?: number } } | undefined
    )?.retain;
    usersHandle = await wireUsers({
      users: userConfigs,
      root,
      configDir: location.configDir,
      ...(historyRetain !== undefined ? { historyRetain } : {}),
      signal: abort.signal,
      start: autoStart,
    });
    runs.push(...usersHandle.runs);
    const userRuntimes = usersHandle.users;
    // Channel bindings (§17.2, FR-125): which users a channel serves, and the
    // alias↔user maps that give an inbound event its sender (§17.6).
    const bindingsOf = (channel: TeamaiConfig["channels"][number]): UserRuntime[] => {
      const key = channelName(channel);
      return userConfigs.flatMap((user) => {
        const runtime = userRuntimes.get(user.name);
        return runtime !== undefined && Object.hasOwn(user.channels ?? {}, key) ? [runtime] : [];
      });
    };
    const identityOf = (channel: TeamaiConfig["channels"][number]): ChannelIdentity | undefined => {
      const key = channelName(channel);
      if (channel.type === "webchat") return undefined; // identity IS the login (§17.6)
      const userByAlias = new Map<string, string>();
      const aliasByUser = new Map<string, string>();
      for (const user of userConfigs) {
        const binding = user.channels?.[key];
        if (binding === undefined || binding === true) continue;
        userByAlias.set(binding.alias, user.name);
        aliasByUser.set(user.name, binding.alias);
      }
      return {
        userOf: (alias) => userByAlias.get(alias),
        aliasOf: (user) => aliasByUser.get(user),
        // What this user may address (§17.6-2): their topology neighbours — the
        // router re-checks the edge, this only bounds the @token scan.
        peersOf: (user) => topology.neighbors(user),
      };
    };

    channelsHandle = await wireChannels({
      channels: config.channels,
      router,
      root,
      configDir: location.configDir,
      usersOf: (channel) =>
        bindingsOf(channel).map((runtime) => ({
          name: runtime.name,
          ...(runtime.config.displayName !== undefined
            ? { displayName: runtime.config.displayName }
            : {}),
          ...(runtime.config.color !== undefined ? { color: runtime.config.color } : {}),
          role: userRole(runtime.config),
          ...(runtime.config.auth?.password !== undefined
            ? { password: runtime.config.auth.password }
            : {}),
          ...(runtime.config.auth?.passwordHash !== undefined
            ? { passwordHash: runtime.config.auth.passwordHash }
            : {}),
          history: runtime.history,
          ports: makePorts(runtime.name),
          lifecycle: makeLifecycle(runtime.name),
        })),
      identityOf,
      registerPush: (user, channel, push) => {
        userRuntimes.get(user)?.targets.push({ channel, push });
      },
      // Instance label for the panel (FR-90, §12.7): the configured `name`, or the
      // host's hostname() when omitted — resolved here because the default is
      // environment-derived, not a config value.
      instanceName: config.name ?? hostname(),
      makePorts,
      makeLifecycle,
      // Read-only transport observability (FR-48, §12.4): page + live feed,
      // never mutation — the panel watches the whole transport, it cannot
      // write the log.
      transport: {
        page: (opts) => transportLog.page(opts),
        subscribe: (listener) => transportLog.subscribe(listener),
      },
      knownAgents: config.agents.map((agent) => agent.name),
      signal: abort.signal,
      ...(options.makeConnector !== undefined ? { makeConnector: options.makeConnector } : {}),
    });
    runs.push(...channelsHandle.runs);

    // 8c. federation (§18, FR-137…FR-146): link queues + egress dispatchers,
    //     link clients, the listener and the status publisher. The router's
    //     federation ports were built in step 5; this is the runtime around them.
    federationHandle = await wireFederation({
      config,
      root,
      router,
      signal: abort.signal,
      start: autoStart,
      agentStatusOf: (name) => agents.get(name)?.state.status,
      presenceOf: (name) => presence.presence(name),
      isPaused,
    });
    if (federationHandle !== undefined) runs.push(...federationHandle.runs);

    // 9. network surface (§8.1): one port, two planes — /mcp (when on) and the
    //    loopback-only /admin operator-plane (§8.5, §10.10).
    // Queue edits resolve a participant name to its queue runtime: the agent's
    // dispatcher or the operator's egress dispatcher — each the single owner of
    // its pending/cur (§10.8); mutations go through its control lane (§8.5).
    const liveChannels = channelsHandle.channels;
    const resolveQueue = (name: string): QueueRuntime | undefined => {
      const agentRuntime = agents.get(name);
      if (agentRuntime !== undefined) {
        return {
          paths: sessionPaths(root, agentRuntime.session),
          lane: agentRuntime.dispatcher.control,
          doneIds: agentRuntime.dispatcher.doneIds,
        };
      }
      const channel = liveChannels.get(name);
      if (channel?.egress !== undefined) {
        return {
          paths: sessionPaths(root, name),
          lane: channel.egress.control,
          doneIds: channel.egress.doneIds,
        };
      }
      // A user's pseudo-session (§17.5) is edited exactly like an operator's.
      const user = usersHandle?.users.get(name);
      if (user !== undefined) {
        return {
          paths: sessionPaths(root, name),
          lane: user.egress.control,
          doneIds: user.egress.doneIds,
        };
      }
      // A federation link queue (§18.5) is observable/editable like any other —
      // its egress dispatcher owns pending/cur (§10.8 generalized to links).
      const linkEgress = federationHandle?.egresses.get(name);
      if (linkEgress !== undefined) {
        return {
          paths: sessionPaths(fedQueueRoot(root), name),
          lane: linkEgress.control,
          doneIds: linkEgress.doneIds,
        };
      }
      return undefined;
    };

    // Operator command-fanout (§15.8, FR-115): the admin plane is fully trusted
    // (no neighbour gate) — dispatch the slash to every agent in the selector
    // intersection via the SAME control-lane path as a single command; a
    // per-agent failure (busy/down/no command) becomes COMMAND_FAILED without
    // sinking the fan-out (§10.18). Error text scrubbed like every other (§8.7).
    const adminCommandFanout = (slash: string, selectors: readonly string[]) =>
      commandFanout(slash, selectors, {
        resolveBroadcast,
        isAgent: (name) => agents.has(name),
        dispatchOne: async (agent, command) => {
          try {
            return { to: agent, ok: true, output: await lifecycleAdmin.command(agent, command) };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { to: agent, ok: false, code: "COMMAND_FAILED", output: redactText(reason) };
          }
        },
      });
    adminHandler = createAdminHandler({
      redactText,
      lifecycle: lifecycleAdmin,
      commandFanout: adminCommandFanout,
      channels: createChannelsAdmin(channelsHandle.channels),
      signals: createSignalsAdmin({ router, isNode: isKnownIdentity }),
      // Blob intake for signal attachments (FR-46) — the shared <root>/blobs/ store.
      blobs: createBlobsAdmin({ blobs }),
      queues: createQueuesAdmin({ resolve: resolveQueue, stamp: () => router.stamp() }),
      routines: createRoutinesAdmin({
        routinesDir: location.routinesDir,
        knownAgents: config.agents.map((agent) => agent.name),
        state: createFsStateStore(location.stateDir),
        router,
      }),
    });
    surface = startSurface({
      port: config.server.port,
      admin: adminHandler,
      ...(mcpCore !== undefined ? { mcp: (req) => mcpCore.fetch(req) } : {}),
    });

    // 10. retention sweep (§5.4, FR-34): per-session double cap on done/ +
    //     independent failed/ pruning + blob GC; the per-agent retain override
    //     falls back to server.retain (§7.1); the live dedup window shrinks with
    //     done/ (§10.9). The egress dispatcher already runs per operator, so its
    //     pseudo-session prunes with the server-level policy.
    const targets: RetentionTarget[] = [
      ...[...agents.values()].map((runtime) => ({
        session: runtime.session,
        policy: retentionPolicy(runtime.agent.retain ?? config.server.retain),
        forgetDone: (ids: Iterable<string>) => runtime.dispatcher.forgetDone(ids),
      })),
      ...[...channelsHandle.channels.values()].flatMap((channel) =>
        channel.operator !== undefined && channel.egress !== undefined
          ? [
              {
                session: channel.operator,
                policy: retentionPolicy(config.server.retain),
                forgetDone: (ids: Iterable<string>) => channel.egress?.forgetDone(ids),
              },
            ]
          : [],
      ),
      // Every user's pseudo-session prunes on the same server-level policy (§17.5).
      ...[...(usersHandle?.users.values() ?? [])].map((user) => ({
        session: user.name,
        policy: retentionPolicy(config.server.retain),
        forgetDone: (ids: Iterable<string>) => user.egress.forgetDone(ids),
      })),
      // Link queues (§18.5) prune like every maildir — under their own root; the
      // dedup window that guards cross-server redelivery shrinks with done/ (§10.9).
      ...[...(federationHandle?.egresses ?? new Map<string, EgressDispatcher>())].map(
        ([link, egress]) => ({
          session: link,
          root: fedQueueRoot(root),
          policy: retentionPolicy(config.server.retain),
          forgetDone: (ids: Iterable<string>) => egress.forgetDone(ids),
        }),
      ),
    ];
    // Webchat history (§12.3) joins the sweep: its own double cap prunes BEFORE
    // blob GC, and its live records keep their blobs referenced past the queue
    // window (FR-39).
    // Every panel log joins the sweep: the legacy operator's one, and — in users
    // mode — each user's own (§17.7). The user histories come from their runtimes,
    // which own them (the connector only reads them).
    const histories = [
      ...[...channelsHandle.channels.values()].flatMap((channel) =>
        channel.connector instanceof WebchatConnector && channel.connector.history !== undefined
          ? [channel.connector.history]
          : [],
      ),
      ...[...(usersHandle?.users.values() ?? [])].map((user) => user.history),
    ];
    const sweepMs = options.retentionSweepMs ?? cadence.retentionSweepMs;
    // Exchange orphan sweeps (§13.3): inbox dirs left by a crash between turn end
    // and cleanup; the in-flight cur/ message (and anything fresh) is kept.
    // Late-reply harvest (FR-74): a reply.md written AFTER the agent deleted
    // message.json (broken contract order — the turn closed empty) is collected
    // by the sweep and routed with the SAME deterministic id `<id>:reply`, so a
    // normally-collected duplicate collapses in the dedup window (§10.9).
    const exchangeSweeps = [...agents.values()].flatMap((runtime) => {
      const exchange = exchanges.get(runtime.name);
      if (exchange === undefined) return [];
      return [
        async (): Promise<void> => {
          const active = await inFlightId(root, runtime.session);
          await exchange.sweepOrphans(new Set(active !== null ? [active] : []), (late) =>
            routeExchangeReply(late, {
              agent: runtime.name,
              exchange,
              blobs,
              route: (reply) => router.route(reply),
            }),
          );
        },
      ];
    });
    // The transport log (FR-48) sweeps and pins blobs like the histories: its
    // records may reference blobs past the queue window.
    retention = createRetention({
      root,
      targets,
      blobAgeMs: retentionPolicy(config.server.retain).ageMs,
      extraSweeps: [
        ...histories.map((history) => () => history.prune()),
        () => transportLog.prune(),
        ...exchangeSweeps,
      ],
      extraRefFiles: async () =>
        (
          await Promise.all([
            ...histories.map((history) => history.listFiles()),
            transportLog.listFiles(),
          ])
        ).flat(),
      ...(sweepMs !== undefined ? { intervalMs: sweepMs } : {}),
    });
    if (options.startRetention ?? true) runs.push(retention.run(abort.signal));

    // 10.5. idle auto-teardown (§5.1, FR-92): a SYSTEM-RAISED agent (provisioned
    //   by us — AgentState.origin) with a resolved teardown.idle window is
    //   gracefully retired after that much transport inactivity. The sweep fires
    //   through the session's control lane (§8.5) so it never interrupts a turn;
    //   the lane op re-validates (idle + empty queue + still-stale) before tearing
    //   down, and the resolved teardown strategy does the graceful close (an
    //   idle-only block ⇒ hard kill). Attach-only / hand-started sessions are left
    //   alone (origin "external"). New queued work later lazy-revives the agent
    //   (FR-51) — a bring-up/idle-down cycle, not a permanent shutdown.
    const idleTargets = [...agents.values()].flatMap((runtime) => {
      const strategy = resolveTeardown(runtime.agent, config.types);
      const idleMs = resolveIdleTeardownMs(strategy);
      if (idleMs === undefined) return [];
      const paths = sessionPaths(root, runtime.session);
      const target = { agent: runtime.agent, adapter: runtime.adapter, state: runtime.state };
      const reviver = revivers.get(runtime.name);
      const teardownDeps = (s?: TeardownConfig) => ({
        control: sessionControl,
        ...(s !== undefined ? { strategy: s } : {}),
      });
      return [
        {
          name: runtime.name,
          idleMs,
          status: () => runtime.state.status,
          isSystemRaised: () => runtime.state.origin === "system",
          // A paused agent is not reaped (§16.3, FR-118): the pause is what stopped
          // its transport, so counting that as idleness would make the pause kill it.
          isPaused: () => isPaused(runtime.name),
          teardown: () =>
            runtime.dispatcher.control.submit(async () => {
              // The lane drains between turns (§8.5): status is idle or down here,
              // never busy. Re-validate against fresh state before retiring.
              if (runtime.state.status !== "idle") return; // gone / mid-resolution
              if (idleSweeper?.isStale(runtime.name) !== true) return; // activity since the tick
              // Don't reap an agent with queued work — let the loop drain it (else
              // a fresh message would just lazy-revive it right back, FR-51).
              if ((await countJson(paths.pending)) + (await countJson(paths.cur)) > 0) return;
              await teardown(target, teardownDeps(strategy));
              // A clean retirement (not a crash) — re-arm the auto-revive budget so
              // the next message lazy-revives the agent (FR-51): the bring-up/idle-
              // down cycle, not a one-way shutdown.
              reviver?.reset();
              process.stderr.write(
                `teamai: "${runtime.name}" idle with no transport activity (${idleMs}ms) — auto-teardown (FR-92)\n`,
              );
            }),
        },
      ];
    });
    if (idleTargets.length > 0) {
      const idleSweepMs = cadence.idleTeardownSweepMs;
      idleSweeper = new IdleTeardownSweeper({
        targets: idleTargets,
        ...(idleSweepMs !== undefined ? { intervalMs: idleSweepMs } : {}),
        ...(options.idleTeardownNow !== undefined ? { now: options.idleTeardownNow } : {}),
      });
      // The lane is drained by the dispatcher loops (autoStart) — only start the
      // sweep where those are live, else its teardown op would never run.
      if ((options.startIdleTeardown ?? true) && autoStart) {
        runs.push(idleSweeper.run(abort.signal));
      }
    }

    // 10.6. liveness probe (§5.1, FR-93): the mirror of idle-teardown — periodically
    //   reconcile every agent's status with its live tmux session so a hand-started
    //   or hand-killed session is reflected WITHOUT a server restart (the per-turn
    //   down-probe FR-16b only catches busy→down). The reconcile runs on the
    //   session's control lane (§8.5): busy is skipped (and re-checked there), so it
    //   never races a turn (§10.1/§10.8). Attach-only — it never provisions (a down
    //   agent with no session stays down; bring-up is FR-50/FR-51/operator).
    livenessSweeper = new LivenessProbeSweeper({
      targets: [...agents.values()].map((runtime) => ({
        name: runtime.name,
        status: () => runtime.state.status,
        reconcile: () =>
          runtime.dispatcher.control.submit(async () => {
            // The lane drains between turns (§8.5): a turn may have started since the
            // tick, so reconcileLiveness re-checks busy (FR-16b) before probing.
            await reconcileLiveness(
              { agent: runtime.agent, adapter: runtime.adapter, state: runtime.state },
              sessionControl,
            );
          }),
      })),
      ...(cadence.livenessProbeMs !== undefined ? { intervalMs: cadence.livenessProbeMs } : {}),
    });
    // The lane is drained by the dispatcher loops (autoStart) — only start the sweep
    // where those are live, else its reconcile op would never run.
    if ((options.startLivenessProbe ?? true) && autoStart) {
      runs.push(livenessSweeper.run(abort.signal));
    }

    // 10.7. rendezvous coordinator (§8.2, FR-105): rehydrate persisted intents (the
    //   guarantee survives a restart, §5.3/§10.9), then run the safety sweep that
    //   notifies an idle sender's blocked TARGET on the rendezvousSweepMs cadence.
    //   Gated on autoStart: without dispatchers the statuses never change, so the
    //   sweep would be inert anyway (and tests drive sweep() directly).
    if (rendezvous !== undefined) {
      await rendezvous.rehydrate();
      if ((options.startRendezvous ?? true) && autoStart) {
        runs.push(rendezvous.run(abort.signal));
      }
    }

    // 10.8. presence fade-out sweep (§17.5, FR-133): appearing is instant (the
    //   router hook), fading out is this cadence. Only started when there are
    //   users at all — presence is a users-mode concept.
    if (userConfigs.length > 0 && autoStart) {
      runs.push(
        presence.run(
          abort.signal,
          config.server.cadence?.presenceSweepMs ?? DEFAULT_PRESENCE_SWEEP_MS,
        ),
      );
    }

    // 11. routine scheduler (§6, §8.2 start order): discover central routines, prime
    //     skip-missed, then tick/re-scan. from = the owning agent; delivery goes through
    //     the same router (edge check §10.2). Off-loop sends accumulate in the recipient's
    //     queue and drain when it is up (§5.1).
    if (options.startRoutines ?? true) {
      // cwd-side discovery (FR-21b, §6.2): agents with a declared cwd also load
      // <cwd>/.teamai/routines/*.md; central overrides by id.
      const agentCwds = new Map<string, string>(
        config.agents.flatMap((agent) =>
          agent.cwd !== undefined ? [[agent.name, agent.cwd] as const] : [],
        ),
      );
      scheduler = startScheduler({
        router,
        state: createFsStateStore(location.stateDir),
        routinesDir: location.routinesDir,
        knownAgents: config.agents.map((agent) => agent.name),
        ...(agentCwds.size > 0 ? { agentCwds } : {}),
        ...(cadence.routineTickMs !== undefined ? { tickIntervalMs: cadence.routineTickMs } : {}),
        ...(cadence.routineRescanMs !== undefined
          ? { rescanIntervalMs: cadence.routineRescanMs }
          : {}),
      });
    }
  } catch (error) {
    abort.abort(); // stop the dispatcher/egress loops started above
    if (channelsHandle !== undefined) await channelsHandle.stop();
    if (federationHandle !== undefined) await federationHandle.stop();
    if (scheduler !== undefined) await scheduler.stop();
    if (surface !== undefined) await surface.stop();
    await Promise.allSettled(runs);
    throw error;
  }

  const channels = channelsHandle;
  const liveSurface = surface;
  const adminFetch = adminHandler;
  if (adminFetch === undefined || retention === undefined) {
    throw new Error("unreachable: admin/retention not built");
  }
  const liveRetention = retention;
  // The agent-plane view keeps the T21 handle shape; stopping it stops the shared
  // surface (idempotent — bootstrap.stop calls it too).
  const agentPlane: AgentPlaneHandle | undefined =
    liveSurface.mcpUrl !== undefined
      ? { port: liveSurface.port, url: liveSurface.mcpUrl, stop: () => liveSurface.stop() }
      : undefined;

  return {
    config,
    router,
    agents,
    channels: channels.channels,
    users: usersHandle?.users ?? new Map(),
    presence,
    warnings: loaded.warnings,
    ...(agentPlane !== undefined ? { agentPlane } : {}),
    adminUrl: liveSurface.adminUrl,
    adminFetch,
    retention: liveRetention,
    ...(idleSweeper !== undefined ? { idleTeardown: idleSweeper } : {}),
    ...(livenessSweeper !== undefined ? { liveness: livenessSweeper } : {}),
    ...(rendezvous !== undefined ? { rendezvous } : {}),
    ...(federationHandle !== undefined ? { federation: federationHandle } : {}),
    status: (name) => agents.get(name)?.state.status,
    stop: async () => {
      abort.abort();
      if (tokenSampler !== undefined) await tokenSampler.stop(); // final token flush (§12.8)
      await channels.stop();
      if (federationHandle !== undefined) await federationHandle.stop();
      if (scheduler !== undefined) await scheduler.stop();
      await liveSurface.stop();
      await Promise.allSettled(runs);
    },
  };
}
