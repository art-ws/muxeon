// Base config schema (§7.1): the validated, resolved shape plus a hand-written
// structural validator. Runs after $ref/$env resolution (§7.2/§7.3); every
// violation is a fatal ConfigError with its location (FR-33). Cross-field rules
// (§7.5 — topology closure, queue-key uniqueness, …) are added in T05.

import type { CommandGrantsMap, SessionGrantsMap } from "@teamai/core";
import { hasEnvKey, joinPointer } from "./env";
import { ConfigError } from "./error";
import { parseKeyScript } from "./key-script";

export interface RetainConfig {
  readonly age?: string;
  readonly count?: number;
}

/**
 * Polling cadences (§7.1, NFR-10) — calibrated defaults (T41), each overridable:
 * outputPollMs 100 (output-fallback/native status poll, §5.2 — must stay below the
 * shortest agent turn; measured dummy-agent turn ≈ 300ms, capture-pane ≈ 3ms),
 * downProbeMs 1000 (§5.1 busy→down probe; has-session ≈ 2ms), routineTickMs 1000 and
 * routineRescanMs 30000 (§6 — the kill-switch/hot-add latency bound),
 * retentionSweepMs 60000 (§5.4), outboxPollMs 1000 (outbox pickup §13.4 — agent
 * initiative is not latency-critical; the settle window is a multiple of the tick),
 * idleTeardownSweepMs 60000 (idle auto-teardown sweep §5.1/FR-92 — coarse: the
 * window is minutes/hours, so ±sweep slop is immaterial), livenessProbeMs 2000
 * (liveness-probe sweep of non-busy sessions §5.1/FR-93 — has-session ≈ 2ms/agent,
 * ~0.1% duty-cycle; the panel sees a hand start/kill within the cadence).
 */
export interface CadenceConfig {
  readonly outputPollMs?: number;
  readonly downProbeMs?: number;
  readonly routineTickMs?: number;
  readonly routineRescanMs?: number;
  readonly retentionSweepMs?: number;
  readonly outboxPollMs?: number;
  /** Idle auto-teardown sweep cadence (§5.1/FR-92); default 60000. */
  readonly idleTeardownSweepMs?: number;
  /** Liveness-probe sweep cadence (§5.1/FR-93); default 2000. */
  readonly livenessProbeMs?: number;
  /**
   * Rendezvous safety-sweep cadence (§8.2/FR-105); default 5000. Backstop for the
   * event-driven trigger (`Dispatcher.afterTurn`): catches a sender that is already
   * idle with a pending intent, or a window that expires with no counter-send.
   */
  readonly rendezvousSweepMs?: number;
  /** User-presence fade-out sweep cadence (§17.5/FR-133); default 60000. */
  readonly presenceSweepMs?: number;
}

export interface ServerConfig {
  readonly port: number;
  readonly mcp: boolean;
  readonly queueDir?: string;
  readonly retain?: RetainConfig;
  readonly cadence?: CadenceConfig;
  /**
   * Presence window of users (§17.5, FR-133): a user counts as `online` while their
   * last SUCCESSFUL outgoing send is younger than this — sliding expiration, every
   * send pushes the window forward. Duration string (§7.1 grammar); absent ⇒
   * {@link DEFAULT_PRESENCE_TTL}. The state is in-memory (a restart starts everyone
   * offline until their first send); the fade-out sweep runs on `cadence.presenceSweepMs`.
   */
  readonly presenceTtl?: string;
  /**
   * Default WIP limit for every gated agent (§8.2 backpressure, FR-104): the most
   * un-drained records (pending + cur) the router admits before refusing new sends
   * with a NACK receipt. Per-agent `agent.wipLimit` overrides it; `0` means
   * unlimited. Absent ⇒ {@link DEFAULT_WIP_LIMIT}.
   */
  readonly wipLimit?: number;
  /**
   * Rendezvous after a WIP strike (§8.2, FR-105): when `A→B` is refused `WIP_LIMIT`
   * (FR-104) the server records an intent and, when sender A next goes idle, notifies
   * target B that A is free and waits for the counter-send `B→A`. Absent ⇒ resolved
   * defaults (enabled). See {@link resolveRendezvous}.
   */
  readonly rendezvous?: RendezvousConfig;
}

/** Default per-agent WIP limit when neither the agent nor the server sets one (FR-104). */
export const DEFAULT_WIP_LIMIT = 3;

/** Default `server.presenceTtl` (§17.5, FR-133) — the user online window. */
export const DEFAULT_PRESENCE_TTL = "15m";
/** Default presence fade-out sweep cadence in ms (§17.5, FR-133). */
export const DEFAULT_PRESENCE_SWEEP_MS = 60_000;

/**
 * Rendezvous / resume-after-WIP-strike config (§8.2, FR-105). Closed shape. When
 * `A→B` is refused `WIP_LIMIT`, an intent `(A→B)` is queued under A; on A going idle
 * the coordinator notifies B ("A is free — send it your message") and opens `window`
 * for the counter-send `B→A`. The intent is dropped ONLY on an accepted `B→A` or on
 * reaching `maxAttempts` (operator decision — no wall-clock TTL).
 */
export interface RendezvousConfig {
  /** Master switch; defaults to `true` when absent. */
  readonly enabled?: boolean;
  /** Wait for the counter-send `B→A` after notifying B; duration string (default `"15s"`). */
  readonly window?: string;
  /** Max notify rounds before the intent is dropped (default `8`). */
  readonly maxAttempts?: number;
}

/** Resolution defaults for {@link RendezvousConfig} (FR-105). */
export const DEFAULT_RENDEZVOUS_ENABLED = true;
export const DEFAULT_RENDEZVOUS_WINDOW = "15s";
export const DEFAULT_RENDEZVOUS_MAX_ATTEMPTS = 8;
/** Default rendezvous safety-sweep cadence in ms (§8.2/FR-105) when `cadence` omits it. */
export const DEFAULT_RENDEZVOUS_SWEEP_MS = 5000;

/** The rendezvous config with defaults applied (FR-105); `window` stays a duration string. */
export interface ResolvedRendezvous {
  readonly enabled: boolean;
  readonly window: string;
  readonly maxAttempts: number;
}

/** Resolve `server.rendezvous` against the FR-105 defaults. */
export function resolveRendezvous(server: ServerConfig): ResolvedRendezvous {
  const r = server.rendezvous;
  return {
    enabled: r?.enabled ?? DEFAULT_RENDEZVOUS_ENABLED,
    window: r?.window ?? DEFAULT_RENDEZVOUS_WINDOW,
    maxAttempts: r?.maxAttempts ?? DEFAULT_RENDEZVOUS_MAX_ATTEMPTS,
  };
}

/**
 * Resolve an agent's effective WIP limit (§8.2, FR-104): agent override, else the
 * server default, else {@link DEFAULT_WIP_LIMIT}. `0` is preserved (unlimited).
 */
export function resolveWipLimit(agent: AgentConfig, server: ServerConfig): number {
  return agent.wipLimit ?? server.wipLimit ?? DEFAULT_WIP_LIMIT;
}

/**
 * Graceful shutdown strategy (FR-64, §5.1): ask the agent to quit itself
 * (slash command and/or raw keys), wait up to graceMs for the session to die,
 * then hard kill-session. At least one of slash/keys/idle is required — a
 * teardown with none IS the hard kill, so the block would be noise.
 */
export interface TeardownConfig {
  /** Slash command name asking the agent to quit (the adapter renders it, FR-9). */
  readonly slash?: string;
  /** Raw tmux key names to send (e.g. ["C-c", "C-d"]); after slash when both set. */
  readonly keys?: readonly string[];
  /** Grace window in ms before the hard kill (default 5000). */
  readonly graceMs?: number;
  /**
   * Idle auto-teardown (FR-92, §5.1): retire a SYSTEM-RAISED session (provisioned
   * by TEAMAI, not attached) after this much transport inactivity — no messages
   * routed to/from it while it stays idle. A duration string (`retain.age` grammar
   * §7.1, e.g. "1h"/"30m") or `true` (the 1h default); absent / `false` ⇒ off. The
   * resolved teardown strategy (this block) does the graceful close; new queued
   * work later lazy-revives the agent (FR-51).
   */
  readonly idle?: string | boolean;
}

export interface ProvisionConfig {
  readonly command: string | readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Auto-provision at server start on attach-miss (FR-50, §5.1); default false. */
  readonly auto?: boolean;
  /** Per-agent graceful shutdown override (FR-64); falls back to types.<type>.teardown. */
  readonly teardown?: TeardownConfig;
}

/**
 * An operator-invokable slash command (FR-66, §8.5/§12.4): rendered by the
 * agent's adapter (FR-9), output captured from the pane as-is. `keys`
 * (T118/T119, FR-80) is the key-DSL script (key-script.ts) interleaving
 * keystrokes, quoted literals and delays around the `capture` point — dialog
 * commands (/usage) close with `keys: "capture Escape"`.
 */
export interface CommandConfig {
  readonly slash: string;
  readonly keys?: string;
}

/**
 * Raw-mode capture rule (FR-88, §14.2): how the dispatcher captures the console
 * AFTER a raw turn completes (busy→idle). `keys` is the SAME key-DSL as slash
 * commands (FR-80, key-script.ts) — steps before `capture` navigate, the marker
 * snapshots the pane (default: the end, after stabilization), steps after return
 * the agent to its prompt. Absent / `{}` ⇒ the default rule (stabilize, then
 * capture the visible pane as-is). The block is closed; per-agent `raw` overrides
 * the per-type one (resolveRaw, like teardown).
 */
export interface RawModeConfig {
  readonly keys?: string;
}

/**
 * Names reserved for INTERNAL slash commands (FR-67): executed by TEAMAI
 * itself, never typed into the agent's console — available on every agent
 * without configuration. A configured command may not shadow one (validation
 * rejects it, §7.5); the implementations live in @teamai/lifecycle, which
 * keys its registry on this list (a test pins the two together).
 */
export const INTERNAL_COMMAND_SLASHES = ["screenshot"] as const;

/**
 * Per-agent-type token accounting (§12.8, FR-103): sample the agent console's
 * token gauge every `sampleEvery`, keep per-minute detail for `minuteSpan`
 * (anything older folds into the hourly maximum), retain a 24h window. Absent
 * block (or `enabled: false`) ⇒ no sampling for the type. The block is closed.
 */
export interface TokenTrackingConfig {
  /** Master switch; defaults to `true` when the block is present. */
  readonly enabled?: boolean;
  /** Console-sample cadence, duration string (default `"60s"`). */
  readonly sampleEvery?: string;
  /** Depth of per-minute resolution, duration string (default `"60m"`); older → hourly max. */
  readonly minuteSpan?: string;
  /** Token ceiling for the panel health indicator — 100% / red (default `1000000`). */
  readonly maxThreshold?: number;
}

/** Per-agent-type defaults (§7.1): teardown strategy + slash commands (FR-64/FR-66). */
export interface AgentTypeConfig {
  readonly teardown?: TeardownConfig;
  /** Type-level command list; merged with agent.commands (agent wins by name). */
  readonly commands?: readonly CommandConfig[];
  /** Type-level raw-mode capture rule (FR-88); per-agent `raw` overrides it. */
  readonly raw?: RawModeConfig;
  /** Type-level token accounting (§12.8, FR-103); absent ⇒ off for the type. */
  readonly tokens?: TokenTrackingConfig;
}

export interface AgentConfig {
  readonly name: string;
  readonly type: string;
  readonly tmux: string;
  readonly cwd?: string;
  /** File-exchange dir override (§13.1); default <cwd>/.teamai → <root>/<session>/exchange. */
  readonly exchangeDir?: string;
  readonly provision?: ProvisionConfig;
  /** Per-agent retention override (§5.4/§7.1); falls back to server.retain. */
  readonly retain?: RetainConfig;
  /** Agent-level slash commands (FR-66); merged over types.<type>.commands. */
  readonly commands?: readonly CommandConfig[];
  /** Agent-level raw-mode capture rule (FR-88); overrides types.<type>.raw. */
  readonly raw?: RawModeConfig;
  /** UI accent color (FR-73), `#rgb`/`#rrggbb`; absent ⇒ the panel picks from its palette. */
  readonly color?: string;
  /**
   * WIP-limit override (§8.2 backpressure, FR-104): the most un-drained records
   * (pending + cur) the router admits for THIS agent before refusing new sends.
   * Falls back to `server.wipLimit` then {@link DEFAULT_WIP_LIMIT}. `0` ⇒ unlimited
   * — set it on hub/coordinator nodes whose reachability must never be throttled.
   */
  readonly wipLimit?: number;
  /**
   * Group membership (§15.1, FR-106): the ONE group this agent belongs to (a
   * broadcast to that group — or any ancestor — reaches it). Must name a group
   * declared in top-level `groups`. Absent ⇒ the agent sits at the tree root.
   */
  readonly group?: string;
  /**
   * Flat tags this agent carries (§15.1, FR-107). The tag namespace is IMPLICIT —
   * the union of every agent's `tags`; a broadcast to a tag reaches all carriers.
   * Non-empty strings, deduped within the agent.
   */
  readonly tags?: readonly string[];
}

/**
 * An agent group (§15.1–15.2, FR-106): a node in the broadcast forest. `parent`
 * (when set) names another declared group, forming a hierarchy; a broadcast to a
 * group reaches every agent in it or any transitive descendant. Closed shape
 * `{ name, parent? }`; uniqueness/acyclicity/reference rules are §7.5 (validate.ts).
 */
export interface GroupConfig {
  readonly name: string;
  readonly parent?: string;
}

export interface ChannelConfig {
  readonly type: string;
  /**
   * Stable instance name of the channel (§17.2, FR-125) — the key of a user's
   * binding (`users[].channels`). Absent ⇒ the `type` (valid while there is only
   * one channel of that type); names are unique across channels, which is what
   * allows two telegram bots side by side (decision §17.10-10).
   */
  readonly name?: string;
  /**
   * Legacy single-operator binding (§12.1): the ONE operator node this channel
   * serves. In users mode (§17.2) it is absent — identity comes from the
   * `users[].channels` bindings instead (FR-125/FR-132).
   */
  readonly bindOperator?: string;
  readonly defaultTarget?: string;
  /** Channel-type-specific fields (e.g. a resolved token); preserved verbatim. */
  readonly [key: string]: unknown;
}

/**
 * A user's password (§17.2, FR-122): EXACTLY one of the two forms.
 * `password` is a literal or an `$env` reference (the point relaxation of §10.7 —
 * a literal warns at boot, decision §17.10-1); `passwordHash` is an inline
 * argon2id/bcrypt hash (a hash is not a secret in the §10.7 sense), generated by
 * `teamai hash-password` (§17.4).
 */
export interface UserAuthConfig {
  readonly password?: string;
  readonly passwordHash?: string;
}

/**
 * One channel binding of a user (§17.2, FR-125), keyed by `channels[].name`:
 * `true` for webchat (the login IS the identity), `{ alias }` for telegram/slack
 * (the identity inside that channel — unique within the channel).
 */
export type UserChannelBinding = true | { readonly alias: string };

/** Roles (§17.2, FR-121): panel-surface coarse role; NO transport ACL (§17.8). */
export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * A human participant (§17.1, FR-121). A full topology node with ONE pseudo-session
 * queue (§5.3) and ≥0 channel bindings; `group`/`tags` work exactly as an agent's
 * (§15.2). `wipLimit` is not settable — a human is never throttled (§17.2).
 */
export interface UserConfig {
  readonly name: string;
  /** Display label in the panel; absent ⇒ `name`. */
  readonly displayName?: string;
  /** UI accent color (FR-73), `#rgb`/`#rrggbb`; absent ⇒ the panel picks one. */
  readonly color?: string;
  /** The ONE group this user belongs to (§15.2, FR-130); must be declared. */
  readonly group?: string;
  /** Flat tags this user carries (§15.2, FR-130). */
  readonly tags?: readonly string[];
  /** Panel role (§17.7, FR-131); absent ⇒ "user". */
  readonly role?: UserRole;
  /** Password block (FR-122); required when the user binds a webchat channel. */
  readonly auth?: UserAuthConfig;
  /** Channel bindings keyed by `channels[].name` (FR-125). */
  readonly channels?: Readonly<Record<string, UserChannelBinding>>;
}

/** The channel's binding key (§17.2, FR-125): its `name`, defaulting to its `type`. */
export function channelName(channel: ChannelConfig): string {
  return channel.name ?? channel.type;
}

/** A user's effective role (§17.2, FR-121): the declared one, default "user". */
export function userRole(user: UserConfig): UserRole {
  return user.role ?? "user";
}

export type TopologyMap = Readonly<Record<string, readonly string[]>>;

export interface TeamaiConfig {
  /**
   * Optional human label for this configuration/instance (FR-90, §7.1) — shown in
   * the web panel topbar and page title (`<name> - TeamAI`). Absent ⇒ the server
   * resolves it to the host's `hostname()` (the default is environment-derived, so
   * it lives at boot, not here).
   */
  readonly name?: string;
  readonly server: ServerConfig;
  readonly agents: readonly AgentConfig[];
  readonly topology: TopologyMap;
  readonly channels: readonly ChannelConfig[];
  /**
   * Human participants (§17.1, FR-121): named people with their own login, queue
   * and channel bindings. Absent ⇒ the legacy single-operator world (§12.1) — the
   * behaviour of every existing config is unchanged (FR-132).
   */
  readonly users?: readonly UserConfig[];
  /**
   * Agent groups (§15.1, FR-106): a forest (`parent`) of broadcast targets; each
   * agent belongs to ≤1 group (`agents[].group`). Absent ⇒ no groups. Groups are
   * input-only topology nodes — addressable `to`, never a queue/session/status.
   */
  readonly groups?: readonly GroupConfig[];
  /** Per-agent-type defaults keyed by adapter type (§7.1, FR-64). */
  readonly types?: Readonly<Record<string, AgentTypeConfig>>;
  /**
   * Directed agent→agent slash-command ACL (FR-94/FR-95, §7.1): a grant
   * `{ "<from>": { "<to>": ["<slash>"] } }` lets agent `from` run those commands
   * on agent `to` via the agent-plane MCP tools (`send_command`/`list_commands`).
   * It NARROWS within the topology — a command still needs a §10.2 edge AND the
   * recipient's catalog (FR-66). `"*"` matches any sender key, any recipient key,
   * and (as a command-list element) every command the recipient has. Absent ⇒ no
   * agent→agent commands are permitted (the §10.10 default).
   */
  readonly commandGrants?: CommandGrantsMap;
  /**
   * Directed agent→agent session-control ACL (FR-96/FR-97, §7.1): a grant
   * `{ "<from>": { "<to>": ["<action>"] } }` lets agent `from` run those lifecycle
   * actions (start/stop/shutdown/restart/reload, SESSION_ACTIONS) on agent `to`'s
   * session via the agent-plane MCP tools (`control_session`/`list_controls`). It
   * NARROWS within the topology — an action still needs a §10.2 edge AND the
   * recipient's applicable catalog (start/restart/reload need a provision command).
   * `"*"` matches any sender key, any recipient key, and (as an action-list element)
   * every action the recipient supports. Absent ⇒ no agent→agent session control is
   * permitted (the §10.10 default).
   */
  readonly sessionGrants?: SessionGrantsMap;
}

// Channel fields treated as secrets: they MUST be `$env` references, never inline
// (§7.3). Channel implementations (T29) may extend this set.
const CHANNEL_SECRET_FIELDS = [
  "token",
  "secret",
  "apiKey",
  "apiSecret",
  "password",
  "webhookSecret",
];

// --- structural helpers -----------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ConfigError("expected an object", { path });
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigError("expected an array", { path });
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ConfigError("expected a string", { path });
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (text.length === 0) throw new ConfigError("expected a non-empty string", { path });
  return text;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError("expected a boolean", { path });
  return value;
}

function requireNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError("expected a non-negative integer", { path });
  }
  return value;
}

function optionalField<T>(
  obj: Record<string, unknown>,
  key: string,
  basePath: string,
  validate: (value: unknown, path: string) => T,
): T | undefined {
  const value = obj[key];
  return value === undefined ? undefined : validate(value, joinPointer(basePath, key));
}

// --- section validators -----------------------------------------------------

function validateRetain(value: unknown, path: string): RetainConfig {
  const obj = requireObject(value, path);
  const retain: { age?: string; count?: number } = {};
  const age = optionalField(obj, "age", path, requireNonEmptyString);
  const count = optionalField(obj, "count", path, requireNonNegativeInt);
  if (age !== undefined) retain.age = age;
  if (count !== undefined) retain.count = count;
  return retain;
}

const CADENCE_FIELDS = [
  "outputPollMs",
  "downProbeMs",
  "routineTickMs",
  "routineRescanMs",
  "retentionSweepMs",
  "outboxPollMs",
  "idleTeardownSweepMs",
  "livenessProbeMs",
  "rendezvousSweepMs",
  "presenceSweepMs",
] as const;

function validateCadence(value: unknown, path: string): CadenceConfig {
  const obj = requireObject(value, path);
  const cadence: Record<string, number> = {};
  for (const field of CADENCE_FIELDS) {
    const fieldPath = joinPointer(path, field);
    const raw = obj[field];
    if (raw === undefined) continue;
    const ms = requireNonNegativeInt(raw, fieldPath);
    if (ms === 0) throw new ConfigError(`${field} must be a positive integer`, { path: fieldPath });
    cadence[field] = ms;
  }
  for (const key of Object.keys(obj)) {
    if (!(CADENCE_FIELDS as readonly string[]).includes(key)) {
      throw new ConfigError(`unknown cadence field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  return cadence;
}

function validateServer(value: unknown, path: string): ServerConfig {
  const obj = requireObject(value, path);
  const portPath = joinPointer(path, "port");
  const port = requireNonNegativeInt(obj.port, portPath);
  if (port > 65535) throw new ConfigError("server.port must be in 0..65535", { path: portPath });
  const mcp = obj.mcp === undefined ? true : requireBoolean(obj.mcp, joinPointer(path, "mcp"));
  const queueDir = optionalField(obj, "queueDir", path, requireNonEmptyString);
  const retain =
    obj.retain === undefined ? undefined : validateRetain(obj.retain, joinPointer(path, "retain"));
  const cadence =
    obj.cadence === undefined
      ? undefined
      : validateCadence(obj.cadence, joinPointer(path, "cadence"));
  const wipLimit = optionalField(obj, "wipLimit", path, requireNonNegativeInt);
  const presenceTtl = optionalField(obj, "presenceTtl", path, requireDuration);
  const rendezvous =
    obj.rendezvous === undefined
      ? undefined
      : validateRendezvous(obj.rendezvous, joinPointer(path, "rendezvous"));
  const server: {
    port: number;
    mcp: boolean;
    queueDir?: string;
    retain?: RetainConfig;
    cadence?: CadenceConfig;
    wipLimit?: number;
    presenceTtl?: string;
    rendezvous?: RendezvousConfig;
  } = {
    port,
    mcp,
  };
  if (queueDir !== undefined) server.queueDir = queueDir;
  if (retain !== undefined) server.retain = retain;
  if (cadence !== undefined) server.cadence = cadence;
  if (wipLimit !== undefined) server.wipLimit = wipLimit;
  if (presenceTtl !== undefined) server.presenceTtl = presenceTtl;
  if (rendezvous !== undefined) server.rendezvous = rendezvous;
  return server;
}

// rendezvous: { enabled?, window?, maxAttempts? } — closed (§8.2, FR-105). `window`
// is a duration string (retain.age grammar §7.1), parsed to ms at boot; `maxAttempts`
// a positive integer. No TTL field — an intent is dropped only on an accepted B→A or
// on maxAttempts (operator decision).
function validateRendezvous(value: unknown, path: string): RendezvousConfig {
  const obj = requireObject(value, path);
  for (const key of Object.keys(obj)) {
    if (key !== "enabled" && key !== "window" && key !== "maxAttempts") {
      throw new ConfigError(`unknown rendezvous field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  const out: { enabled?: boolean; window?: string; maxAttempts?: number } = {};
  if (obj.enabled !== undefined) {
    out.enabled = requireBoolean(obj.enabled, joinPointer(path, "enabled"));
  }
  if (obj.window !== undefined) {
    out.window = requireDuration(obj.window, joinPointer(path, "window"));
  }
  if (obj.maxAttempts !== undefined) {
    const maxPath = joinPointer(path, "maxAttempts");
    const n = requireNonNegativeInt(obj.maxAttempts, maxPath);
    if (n === 0)
      throw new ConfigError("rendezvous.maxAttempts must be a positive integer", { path: maxPath });
    out.maxAttempts = n;
  }
  return out;
}

function validateCommand(value: unknown, path: string): string | string[] {
  if (typeof value === "string") {
    if (value.length === 0) throw new ConfigError("provision.command must be non-empty", { path });
    return value;
  }
  const arr = requireArray(value, path);
  if (arr.length === 0) throw new ConfigError("provision.command must be non-empty", { path });
  return arr.map((item, i) => requireNonEmptyString(item, joinPointer(path, String(i))));
}

function validateStringMap(value: unknown, path: string): Record<string, string> {
  const obj = requireObject(value, path);
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(obj)) {
    out[key] = requireString(child, joinPointer(path, key));
  }
  return out;
}

// Duration grammar (§7.1, same as retain.age): "<n>ms|s|m|h|d", positive amount.
// Parsed to ms at boot (parseRetainAge); the shape/grammar check is fail-fast here.
const DURATION = /^(\d+)(ms|s|m|h|d)$/;

function requireDuration(value: unknown, path: string): string {
  const text = requireNonEmptyString(value, path);
  const match = DURATION.exec(text);
  if (match === null || Number(match[1]) <= 0) {
    throw new ConfigError(`expected a positive duration (e.g. "1h", "30m"), got "${text}"`, {
      path,
    });
  }
  return text;
}

// teardown: { slash?, keys?, graceMs?, idle? } — closed; at least one of
// slash/keys/idle (a teardown with none IS the hard kill — the block would be
// noise, FR-64). `idle` (FR-92): a duration string or boolean — auto-teardown on
// transport inactivity for system-raised sessions (§5.1).
function validateTeardown(value: unknown, path: string): TeardownConfig {
  const obj = requireObject(value, path);
  for (const key of Object.keys(obj)) {
    if (key !== "slash" && key !== "keys" && key !== "graceMs" && key !== "idle") {
      throw new ConfigError(`unknown teardown field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  const slash = optionalField(obj, "slash", path, requireNonEmptyString);
  const keys =
    obj.keys === undefined
      ? undefined
      : requireArray(obj.keys, joinPointer(path, "keys")).map((key, i) =>
          requireNonEmptyString(key, joinPointer(joinPointer(path, "keys"), String(i))),
        );
  // idle: boolean (true ⇒ default 1h, false ⇒ off) or a positive duration string.
  const idle =
    obj.idle === undefined
      ? undefined
      : typeof obj.idle === "boolean"
        ? obj.idle
        : requireDuration(obj.idle, joinPointer(path, "idle"));
  const hasSlashOrKeys = slash !== undefined || (keys !== undefined && keys.length > 0);
  if (!hasSlashOrKeys && obj.idle === undefined) {
    throw new ConfigError("teardown requires slash, keys, and/or idle (else it IS the hard kill)", {
      path,
    });
  }
  const graceMs = obj.graceMs;
  if (
    graceMs !== undefined &&
    (typeof graceMs !== "number" || !Number.isInteger(graceMs) || graceMs < 0)
  ) {
    throw new ConfigError("teardown.graceMs must be a non-negative integer", {
      path: joinPointer(path, "graceMs"),
    });
  }
  const teardown: { slash?: string; keys?: string[]; graceMs?: number; idle?: string | boolean } =
    {};
  if (slash !== undefined) teardown.slash = slash;
  if (keys !== undefined) teardown.keys = keys;
  if (graceMs !== undefined) teardown.graceMs = graceMs as number;
  if (idle !== undefined) teardown.idle = idle;
  return teardown;
}

function validateProvision(value: unknown, path: string): ProvisionConfig {
  const obj = requireObject(value, path);
  const command = validateCommand(obj.command, joinPointer(path, "command"));
  const cwd = optionalField(obj, "cwd", path, requireNonEmptyString);
  const env =
    obj.env === undefined ? undefined : validateStringMap(obj.env, joinPointer(path, "env"));
  const auto = optionalField(obj, "auto", path, requireBoolean);
  const teardown =
    obj.teardown === undefined
      ? undefined
      : validateTeardown(obj.teardown, joinPointer(path, "teardown"));
  const provision: {
    command: string | string[];
    cwd?: string;
    env?: Record<string, string>;
    auto?: boolean;
    teardown?: TeardownConfig;
  } = {
    command,
  };
  if (cwd !== undefined) provision.cwd = cwd;
  if (env !== undefined) provision.env = env;
  if (auto !== undefined) provision.auto = auto;
  if (teardown !== undefined) provision.teardown = teardown;
  return provision;
}

// commands: [{slash, keys?}] — closed per entry; slash names unique in one
// list (the merge keys on them, FR-66) and never an internal name (FR-67);
// `keys` must parse as a key script (FR-80).
function validateCommands(value: unknown, path: string): CommandConfig[] {
  const seen = new Set<string>();
  return requireArray(value, path).map((item, i) => {
    const itemPath = joinPointer(path, String(i));
    const obj = requireObject(item, itemPath);
    for (const key of Object.keys(obj)) {
      if (key !== "slash" && key !== "keys") {
        throw new ConfigError(`unknown command field "${key}"`, {
          path: joinPointer(itemPath, key),
        });
      }
    }
    const slash = requireNonEmptyString(obj.slash, joinPointer(itemPath, "slash"));
    if ((INTERNAL_COMMAND_SLASHES as readonly string[]).includes(slash)) {
      throw new ConfigError(`command "/${slash}" is reserved for an internal command (FR-67)`, {
        path: itemPath,
      });
    }
    if (seen.has(slash)) {
      throw new ConfigError(`duplicate command "/${slash}"`, { path: itemPath });
    }
    seen.add(slash);
    const keys = optionalField(obj, "keys", itemPath, requireNonEmptyString);
    if (keys !== undefined) {
      try {
        parseKeyScript(keys); // fail-fast (§7.5): a broken script is a config error
      } catch (error) {
        throw new ConfigError(error instanceof Error ? error.message : String(error), {
          path: joinPointer(itemPath, "keys"),
        });
      }
    }
    return { slash, ...(keys !== undefined ? { keys } : {}) };
  });
}

// raw: { keys? } — closed; `keys` (when set) must parse as a key script (FR-80),
// the SAME validation slash commands get, so a broken rule is a config error at
// load (§7.5), never a runtime surprise during a raw turn (FR-88, §14.2).
function validateRaw(value: unknown, path: string): RawModeConfig {
  const obj = requireObject(value, path);
  for (const key of Object.keys(obj)) {
    if (key !== "keys") {
      throw new ConfigError(`unknown raw field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  const keys = optionalField(obj, "keys", path, requireNonEmptyString);
  if (keys !== undefined) {
    try {
      parseKeyScript(keys); // fail-fast (§7.5): a broken rule is a config error
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error), {
        path: joinPointer(path, "keys"),
      });
    }
  }
  return keys !== undefined ? { keys } : {};
}

// tokens: { enabled?, sampleEvery?, minuteSpan?, maxThreshold? } — closed (§12.8, FR-103).
// Per-agent-type token accounting: the shape/grammar check is fail-fast here; the
// duration strings are parsed to ms by the sampler at boot (parseRetainAge grammar).
function validateTokens(value: unknown, path: string): TokenTrackingConfig {
  const obj = requireObject(value, path);
  for (const key of Object.keys(obj)) {
    if (
      key !== "enabled" &&
      key !== "sampleEvery" &&
      key !== "minuteSpan" &&
      key !== "maxThreshold"
    ) {
      throw new ConfigError(`unknown tokens field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  const out: {
    enabled?: boolean;
    sampleEvery?: string;
    minuteSpan?: string;
    maxThreshold?: number;
  } = {};
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new ConfigError("tokens.enabled must be a boolean", {
        path: joinPointer(path, "enabled"),
      });
    }
    out.enabled = obj.enabled;
  }
  if (obj.sampleEvery !== undefined) {
    out.sampleEvery = requireDuration(obj.sampleEvery, joinPointer(path, "sampleEvery"));
  }
  if (obj.minuteSpan !== undefined) {
    out.minuteSpan = requireDuration(obj.minuteSpan, joinPointer(path, "minuteSpan"));
  }
  if (obj.maxThreshold !== undefined) {
    if (
      typeof obj.maxThreshold !== "number" ||
      !Number.isInteger(obj.maxThreshold) ||
      obj.maxThreshold <= 0
    ) {
      throw new ConfigError("tokens.maxThreshold must be a positive integer", {
        path: joinPointer(path, "maxThreshold"),
      });
    }
    out.maxThreshold = obj.maxThreshold;
  }
  return out;
}

// types: { <adapter-type>: { teardown?, commands?, raw?, tokens? } } — closed per entry (§7.1).
function validateTypes(value: unknown, path: string): Record<string, AgentTypeConfig> {
  const obj = requireObject(value, path);
  const out: Record<string, AgentTypeConfig> = {};
  for (const [type, entry] of Object.entries(obj)) {
    const entryPath = joinPointer(path, type);
    const record = requireObject(entry, entryPath);
    for (const key of Object.keys(record)) {
      if (key !== "teardown" && key !== "commands" && key !== "raw" && key !== "tokens") {
        throw new ConfigError(`unknown type field "${key}"`, { path: joinPointer(entryPath, key) });
      }
    }
    const teardown =
      record.teardown === undefined
        ? undefined
        : validateTeardown(record.teardown, joinPointer(entryPath, "teardown"));
    const commands =
      record.commands === undefined
        ? undefined
        : validateCommands(record.commands, joinPointer(entryPath, "commands"));
    const raw =
      record.raw === undefined ? undefined : validateRaw(record.raw, joinPointer(entryPath, "raw"));
    const tokens =
      record.tokens === undefined
        ? undefined
        : validateTokens(record.tokens, joinPointer(entryPath, "tokens"));
    out[type] = {
      ...(teardown !== undefined ? { teardown } : {}),
      ...(commands !== undefined ? { commands } : {}),
      ...(raw !== undefined ? { raw } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
    };
  }
  return out;
}

// color: a CSS hex color (FR-73) — the closed shape keeps the value safely
// injectable into the panel's styles (no arbitrary CSS reaches the client).
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function validateColor(value: unknown, path: string): string {
  const text = requireNonEmptyString(value, path);
  if (!HEX_COLOR.test(text)) {
    throw new ConfigError(`color must be a hex color ("#rgb" or "#rrggbb"), got "${text}"`, {
      path,
    });
  }
  return text;
}

function validateAgent(value: unknown, path: string): AgentConfig {
  const obj = requireObject(value, path);
  const name = requireNonEmptyString(obj.name, joinPointer(path, "name"));
  const type = requireNonEmptyString(obj.type, joinPointer(path, "type"));
  const tmux = requireNonEmptyString(obj.tmux, joinPointer(path, "tmux"));
  const cwd = optionalField(obj, "cwd", path, requireNonEmptyString);
  const exchangeDir = optionalField(obj, "exchangeDir", path, requireNonEmptyString);
  const provision =
    obj.provision === undefined
      ? undefined
      : validateProvision(obj.provision, joinPointer(path, "provision"));
  const retain =
    obj.retain === undefined ? undefined : validateRetain(obj.retain, joinPointer(path, "retain"));
  const commands =
    obj.commands === undefined
      ? undefined
      : validateCommands(obj.commands, joinPointer(path, "commands"));
  const raw = obj.raw === undefined ? undefined : validateRaw(obj.raw, joinPointer(path, "raw"));
  const color = optionalField(obj, "color", path, validateColor);
  const wipLimit = optionalField(obj, "wipLimit", path, requireNonNegativeInt);
  const group = optionalField(obj, "group", path, requireNonEmptyString);
  const tags =
    obj.tags === undefined ? undefined : validateTags(obj.tags, joinPointer(path, "tags"));
  const agent: {
    name: string;
    type: string;
    tmux: string;
    cwd?: string;
    exchangeDir?: string;
    provision?: ProvisionConfig;
    retain?: RetainConfig;
    commands?: CommandConfig[];
    raw?: RawModeConfig;
    color?: string;
    wipLimit?: number;
    group?: string;
    tags?: string[];
  } = {
    name,
    type,
    tmux,
  };
  if (cwd !== undefined) agent.cwd = cwd;
  if (exchangeDir !== undefined) agent.exchangeDir = exchangeDir;
  if (provision !== undefined) agent.provision = provision;
  if (retain !== undefined) agent.retain = retain;
  if (commands !== undefined) agent.commands = commands;
  if (raw !== undefined) agent.raw = raw;
  if (color !== undefined) agent.color = color;
  if (wipLimit !== undefined) agent.wipLimit = wipLimit;
  if (group !== undefined) agent.group = group;
  if (tags !== undefined) agent.tags = tags;
  return agent;
}

function validateAgents(value: unknown, path: string): AgentConfig[] {
  return requireArray(value, path).map((item, i) =>
    validateAgent(item, joinPointer(path, String(i))),
  );
}

// tags: [string] — non-empty, deduped within the agent (§15.2, FR-107). The tag
// namespace is implicit (union across agents); cross-name disjointness (§10.17) is §7.5.
function validateTags(value: unknown, path: string): string[] {
  const seen = new Set<string>();
  return requireArray(value, path).map((item, i) => {
    const tag = requireNonEmptyString(item, joinPointer(path, String(i)));
    if (seen.has(tag)) {
      throw new ConfigError(`duplicate tag "${tag}"`, { path: joinPointer(path, String(i)) });
    }
    seen.add(tag);
    return tag;
  });
}

// groups: [{ name, parent? }] — closed per entry (§15.2, FR-106). Name uniqueness,
// acyclic hierarchy and parent/reference closure are §7.5 (validate.ts); this is shape only.
function validateGroups(value: unknown, path: string): GroupConfig[] {
  return requireArray(value, path).map((item, i) => {
    const itemPath = joinPointer(path, String(i));
    const obj = requireObject(item, itemPath);
    for (const key of Object.keys(obj)) {
      if (key !== "name" && key !== "parent") {
        throw new ConfigError(`unknown group field "${key}"`, {
          path: joinPointer(itemPath, key),
        });
      }
    }
    const name = requireNonEmptyString(obj.name, joinPointer(itemPath, "name"));
    const parent = optionalField(obj, "parent", itemPath, requireNonEmptyString);
    return { name, ...(parent !== undefined ? { parent } : {}) };
  });
}

function validateTopology(value: unknown, path: string): Record<string, string[]> {
  const obj = requireObject(value, path);
  const out: Record<string, string[]> = {};
  for (const [node, neighbors] of Object.entries(obj)) {
    const nodePath = joinPointer(path, node);
    out[node] = requireArray(neighbors, nodePath).map((n, i) =>
      requireNonEmptyString(n, joinPointer(nodePath, String(i))),
    );
  }
  return out;
}

// commandGrants: { <from>: { <to>: [<slash>, ...] } } — the directed agent→agent
// command ACL (FR-94/FR-95). Structural only here; §7.5 (validate.ts) checks that
// the nodes are known agents, the explicit pairs have a topology edge, and the
// named commands exist. "*" is legal as a sender key, a recipient key, and a
// command-list element (the wildcard, COMMAND_WILDCARD); list entries are unique.
function validateCommandGrants(value: unknown, path: string): CommandGrantsMap {
  const obj = requireObject(value, path);
  const out: Record<string, Record<string, string[]>> = {};
  for (const [from, recipients] of Object.entries(obj)) {
    const fromPath = joinPointer(path, from);
    const inner: Record<string, string[]> = {};
    for (const [to, slashes] of Object.entries(requireObject(recipients, fromPath))) {
      const toPath = joinPointer(fromPath, to);
      const seen = new Set<string>();
      inner[to] = requireArray(slashes, toPath).map((entry, i) => {
        const slash = requireNonEmptyString(entry, joinPointer(toPath, String(i)));
        if (seen.has(slash)) {
          throw new ConfigError(`duplicate command "${slash}" in grant ${from} → ${to}`, {
            path: joinPointer(toPath, String(i)),
          });
        }
        seen.add(slash);
        return slash;
      });
    }
    out[from] = inner;
  }
  return out;
}

// sessionGrants: { <from>: { <to>: [<action>, ...] } } — the directed agent→agent
// session-control ACL (FR-96/FR-97). Structural only here; §7.5 (validate.ts) checks
// that the nodes are known agents, the explicit pairs have a topology edge, and the
// actions are valid/applicable. "*" is legal as a sender key, a recipient key, and an
// action-list element (the wildcard, SESSION_WILDCARD); list entries are unique.
function validateSessionGrants(value: unknown, path: string): SessionGrantsMap {
  const obj = requireObject(value, path);
  const out: Record<string, Record<string, string[]>> = {};
  for (const [from, recipients] of Object.entries(obj)) {
    const fromPath = joinPointer(path, from);
    const inner: Record<string, string[]> = {};
    for (const [to, actions] of Object.entries(requireObject(recipients, fromPath))) {
      const toPath = joinPointer(fromPath, to);
      const seen = new Set<string>();
      inner[to] = requireArray(actions, toPath).map((entry, i) => {
        const action = requireNonEmptyString(entry, joinPointer(toPath, String(i)));
        if (seen.has(action)) {
          throw new ConfigError(`duplicate action "${action}" in grant ${from} → ${to}`, {
            path: joinPointer(toPath, String(i)),
          });
        }
        seen.add(action);
        return action;
      });
    }
    out[from] = inner;
  }
  return out;
}

function validateChannel(value: unknown, path: string): ChannelConfig {
  const obj = requireObject(value, path);
  const type = requireNonEmptyString(obj.type, joinPointer(path, "type"));
  // name (§17.2, FR-125): the binding key; absent ⇒ the type. bindOperator became
  // OPTIONAL with users mode (§17.2) — a channel either binds one legacy operator
  // or takes its identities from the users' bindings; §7.5 decides which.
  const name = optionalField(obj, "name", path, requireNonEmptyString);
  const bindOperator = optionalField(obj, "bindOperator", path, requireNonEmptyString);
  const defaultTarget = optionalField(obj, "defaultTarget", path, requireNonEmptyString);
  // Preserve channel-type-specific fields (e.g. the resolved token) verbatim.
  const channel: Record<string, unknown> = { ...obj, type };
  if (name !== undefined) channel.name = name;
  if (bindOperator !== undefined) channel.bindOperator = bindOperator;
  if (defaultTarget !== undefined) channel.defaultTarget = defaultTarget;
  return channel as ChannelConfig;
}

// users: [{ name, displayName?, color?, group?, tags?, role?, auth?, channels? }] —
// closed per entry (§17.2, FR-121). Shape only; the namespace/queue-key/binding
// rules are §7.5 (validate.ts).
const USER_FIELDS = [
  "name",
  "displayName",
  "color",
  "group",
  "tags",
  "role",
  "auth",
  "channels",
] as const;

function validateUsers(value: unknown, path: string): UserConfig[] {
  return requireArray(value, path).map((item, i) => {
    const itemPath = joinPointer(path, String(i));
    const obj = requireObject(item, itemPath);
    for (const key of Object.keys(obj)) {
      if (!(USER_FIELDS as readonly string[]).includes(key)) {
        throw new ConfigError(`unknown user field "${key}"`, { path: joinPointer(itemPath, key) });
      }
    }
    const name = requireNonEmptyString(obj.name, joinPointer(itemPath, "name"));
    const displayName = optionalField(obj, "displayName", itemPath, requireNonEmptyString);
    const color = optionalField(obj, "color", itemPath, validateColor);
    const group = optionalField(obj, "group", itemPath, requireNonEmptyString);
    const tags =
      obj.tags === undefined ? undefined : validateTags(obj.tags, joinPointer(itemPath, "tags"));
    const role = optionalField(obj, "role", itemPath, validateUserRole);
    const auth =
      obj.auth === undefined
        ? undefined
        : validateUserAuth(obj.auth, joinPointer(itemPath, "auth"));
    const channels =
      obj.channels === undefined
        ? undefined
        : validateUserChannels(obj.channels, joinPointer(itemPath, "channels"));
    return {
      name,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(channels !== undefined ? { channels } : {}),
    };
  });
}

function validateUserRole(value: unknown, path: string): UserRole {
  const text = requireNonEmptyString(value, path);
  if (!(USER_ROLES as readonly string[]).includes(text)) {
    throw new ConfigError(`role must be one of ${USER_ROLES.join("/")}, got "${text}"`, { path });
  }
  return text as UserRole;
}

// auth: exactly one of password | passwordHash — closed (§17.2, FR-122). The
// password arrives here already $env-resolved (§7.3) when it was a reference; an
// inline literal is allowed (decision §17.10-1) and warned about at load.
function validateUserAuth(value: unknown, path: string): UserAuthConfig {
  const obj = requireObject(value, path);
  for (const key of Object.keys(obj)) {
    if (key !== "password" && key !== "passwordHash") {
      throw new ConfigError(`unknown auth field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  const password = optionalField(obj, "password", path, requireNonEmptyString);
  const passwordHash = optionalField(obj, "passwordHash", path, requireNonEmptyString);
  if ((password === undefined) === (passwordHash === undefined)) {
    throw new ConfigError("auth requires exactly one of password | passwordHash (§17.2)", { path });
  }
  return {
    ...(password !== undefined ? { password } : {}),
    ...(passwordHash !== undefined ? { passwordHash } : {}),
  };
}

// channels: { "<channel name>": true | { alias } } — closed per binding (§17.2,
// FR-125). `true` is webchat (identity = the login); `{ alias }` is the identity
// inside telegram/slack. Which form a given channel requires is §7.5.
function validateUserChannels(value: unknown, path: string): Record<string, UserChannelBinding> {
  const obj = requireObject(value, path);
  const out: Record<string, UserChannelBinding> = {};
  for (const [channel, binding] of Object.entries(obj)) {
    const bindingPath = joinPointer(path, channel);
    if (binding === true) {
      out[channel] = true;
      continue;
    }
    const record = requireObject(binding, bindingPath);
    for (const key of Object.keys(record)) {
      if (key !== "alias") {
        throw new ConfigError(`unknown binding field "${key}"`, {
          path: joinPointer(bindingPath, key),
        });
      }
    }
    out[channel] = {
      alias: requireNonEmptyString(record.alias, joinPointer(bindingPath, "alias")),
    };
  }
  return out;
}

function validateChannels(value: unknown, path: string): ChannelConfig[] {
  if (value === undefined) return [];
  return requireArray(value, path).map((item, i) =>
    validateChannel(item, joinPointer(path, String(i))),
  );
}

/** Validates the resolved config against the base schema (§7.1). Fail-fast. */
export function validateStructure(value: unknown): TeamaiConfig {
  const root = requireObject(value, "");
  const types = root.types === undefined ? undefined : validateTypes(root.types, "/types");
  const name = root.name === undefined ? undefined : requireNonEmptyString(root.name, "/name");
  const commandGrants =
    root.commandGrants === undefined
      ? undefined
      : validateCommandGrants(root.commandGrants, "/commandGrants");
  const sessionGrants =
    root.sessionGrants === undefined
      ? undefined
      : validateSessionGrants(root.sessionGrants, "/sessionGrants");
  const groups = root.groups === undefined ? undefined : validateGroups(root.groups, "/groups");
  const users = root.users === undefined ? undefined : validateUsers(root.users, "/users");
  return {
    ...(name !== undefined ? { name } : {}),
    server: validateServer(root.server, "/server"),
    agents: validateAgents(root.agents, "/agents"),
    topology: validateTopology(root.topology, "/topology"),
    channels: validateChannels(root.channels, "/channels"),
    ...(users !== undefined ? { users } : {}),
    ...(types !== undefined ? { types } : {}),
    ...(commandGrants !== undefined ? { commandGrants } : {}),
    ...(sessionGrants !== undefined ? { sessionGrants } : {}),
    ...(groups !== undefined ? { groups } : {}),
  };
}

/**
 * Enforces §7.3 on the PRE-$env tree: any channel secret field present must be an
 * `$env` reference, never an inline value (post-resolution the two are
 * indistinguishable, so this must run before resolveEnv).
 */
export function assertChannelSecretsAreEnvRefs(parsed: unknown): void {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.channels)) return; // shape errors caught later
  for (const [i, channel] of parsed.channels.entries()) {
    if (!isPlainObject(channel)) continue;
    const basePath = joinPointer("/channels", String(i));
    for (const field of CHANNEL_SECRET_FIELDS) {
      if (Object.hasOwn(channel, field) && !hasEnvKey(channel[field])) {
        throw new ConfigError(
          `channel secret "${field}" must be an { "$env": ... } reference, not an inline value`,
          { path: joinPointer(basePath, field) },
        );
      }
    }
    // webchat nests its secret one level deeper: auth.password (§12.2) — legacy
    // mode only; in users mode the channel carries no password at all (§17.2).
    if (isPlainObject(channel.auth) && Object.hasOwn(channel.auth, "password")) {
      if (!hasEnvKey(channel.auth.password)) {
        throw new ConfigError(
          'channel secret "auth.password" must be an { "$env": ... } reference, not an inline value',
          { path: joinPointer(joinPointer(basePath, "auth"), "password") },
        );
      }
    }
  }
}

/**
 * Users whose password is an INLINE literal (§17.2, FR-122) — read from the
 * PRE-$env tree, where a reference is still distinguishable from a value. A
 * literal is legal here (the point relaxation of §10.7, decision §17.10-1), so
 * this is not an error: the loader turns each name into a boot warning.
 */
export function inlineUserPasswords(parsed: unknown): string[] {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.users)) return [];
  const names: string[] = [];
  for (const user of parsed.users) {
    if (!isPlainObject(user) || !isPlainObject(user.auth)) continue;
    if (!Object.hasOwn(user.auth, "password")) continue;
    if (hasEnvKey(user.auth.password)) continue;
    names.push(typeof user.name === "string" ? user.name : "<unnamed>");
  }
  return names;
}
