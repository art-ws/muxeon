// Read-only dynamics ports (T46, FR-40, §12.4) — injected at assembly by the
// server (like deliver/router.route, §5.3) so the §8 graph stays acyclic:
// orchestrator never imports webchat. Capability-wise this is exactly the
// agent-plane view of the bound operator (§8.6: peers + status, neighbor-scoped
// §10.2) plus queue *observation* — never mutation (§10.8): the panel watches
// pending→cur→done/failed, it does not move records.

import type { AgentStatus, Signal } from "@muxeon/core";

/** Where a sent message currently is in the recipient's queue (§5.3). */
export type MessagePhase = "pending" | "cur" | "done" | "failed";

/** One token histogram column: bucket-start unix ms + the slot's max gauge (§12.8). */
export interface TokenBucket {
  readonly t: number;
  readonly tokens: number;
}

/**
 * The panel's token-usage view for one agent (§12.8, FR-103): a two-zone series
 * (recent per-minute + older per-hour, both max-aggregated over a 24h window) plus
 * the live gauge and its ceiling. A plain data shape so the §8 graph stays acyclic
 * (webchat never imports orchestrator); the server adapts its store to this.
 */
export interface TokenSeries {
  /** Per-minute columns within the minute window (recent), ascending by time. */
  readonly minutes: readonly TokenBucket[];
  /** Per-hour columns behind the minute window (down to 24h), ascending by time. */
  readonly hours: readonly TokenBucket[];
  /** Latest sampled gauge (0 when nothing sampled yet). */
  readonly current: number;
  /** Unix ms of the latest sample (0 when none). */
  readonly updatedAt: number;
  /** Token ceiling for the health orb — 100% / red. */
  readonly maxThreshold: number;
}

/**
 * The panel's session-clock view for one agent (§5.5, FR-197) — the same clock the
 * agent plane serves through `get_status`, expressed as DURATIONS so the viewer's
 * browser clock never has to agree with the server's. A plain data shape, like
 * {@link TokenSeries}: webchat never imports orchestrator (§8).
 */
export interface PeerClock {
  /** How long the live session has been up; absent when down or unknown. */
  readonly uptimeMs?: number;
  /** How long since the newest sign of life; absent when nothing was witnessed. */
  readonly quietForMs?: number;
  /** Which signal was newest: `session` | `turn` | `transport` | `tokens`. */
  readonly lastActivity?: string;
  /** How long this coordinator has been watching — the floor of the two above. */
  readonly observedForMs: number;
}

/** A group broadcast peer (§15, FR-112): input-only, hierarchical members, no status. */
export interface GroupPeer {
  readonly name: string;
  readonly type: "group";
  readonly parent?: string;
  readonly members: readonly string[];
}

/** A tag broadcast peer (§15, FR-112): input-only, flat carriers, no status. */
export interface TagPeer {
  readonly name: string;
  readonly type: "tag";
  readonly members: readonly string[];
}

export type BroadcastPeer = GroupPeer | TagPeer;

/**
 * A federated peer (§18.4, FR-144/FR-150): a remote actor imported over a link,
 * FQN-named, read-only — the panel shows its projection and opens a plain 1:1
 * chat, never lifecycle/commands/console. `unknown` is an honest value of its
 * own (§10.27), with the cause for the tooltip.
 */
export interface RemotePeerRow {
  readonly name: string;
  readonly type: "agent" | "user";
  /** The import this peer arrived through — the panel's server group (§18.4). */
  readonly server: string;
  readonly link: "up" | "down";
  readonly status?: AgentStatus | "unknown";
  readonly presence?: "online" | "offline" | "unknown";
  readonly paused: boolean;
  readonly reason?: "link-down" | "not-published" | "hop-down";
}

/** Panel role (§17.2/§17.7, FR-121/FR-131). Declared here so webchat stays free of a config dep. */
export type WebchatRole = "admin" | "user";

export interface WebchatPorts {
  /**
   * The identity's topology neighbours that have a chat (§10.2) — agents and, since
   * §17.7 (FR-129), user peers. Groups/tags arrive separately via broadcastPeers.
   */
  listPeers(): readonly string[];
  /** Live agent status (§5.1); undefined for an unknown name. */
  peerStatus(name: string): AgentStatus | undefined;
  /**
   * Is the agent PAUSED (§16, FR-119)? Orthogonal to `peerStatus` — a paused agent
   * can be idle, busy or down (§16.1), so the panel marks it beside the status dot,
   * never instead of the status. Absent ⇒ no pause marking.
   */
  peerPaused?(name: string): boolean;
  /**
   * A peer's kind (§15, FR-112): "agent" (operators included), "group", or "tag".
   * Absent ⇒ "agent" (no groups/tags). Used to reject raw mode to a group/tag and to
   * skip queue-phase tracking for a one-directional broadcast.
   */
  peerType?(name: string): "agent" | "group" | "tag" | "user";
  /**
   * Presence of a USER peer (§17.5, FR-133): "online" while their last outgoing
   * send is inside `server.presenceTtl`, else "offline". Undefined for agents (they
   * have a real session status) and when presence is not wired.
   */
  peerPresence?(name: string): "online" | "offline" | undefined;
  /**
   * A peer's configured display label (§7.1/§17.2, FR-156) — agent or user alike;
   * absent ⇒ the panel shows the name. Presentational only: the name stays the
   * address everywhere (routing, history keys, deep links).
   */
  peerTitle?(name: string): string | undefined;
  /** An agent peer's group membership (§15, FR-112) — drives the sidebar tree. */
  agentGroup?(name: string): string | undefined;
  /** An agent peer's tags (§15, FR-112) — the tag chips / Tags-section membership. */
  agentTags?(name: string): readonly string[];
  /**
   * The operator's group/tag neighbors (§15, FR-112): input-only broadcast targets
   * with their resolved members (hierarchical for a group). No status/queue/unread.
   * Absent ⇒ no groups/tags configured.
   */
  broadcastPeers?(): readonly BroadcastPeer[];
  /** Queue depth of the agent's session: |pending| + |cur|. */
  queueDepth(name: string): Promise<number>;
  /** Phase of message `id` in the agent's queue, or undefined when not found. */
  messagePhase(name: string, id: string): Promise<MessagePhase | undefined>;
  /** Configured UI accent color (FR-73, §7.1); absent/undefined ⇒ the panel picks one. */
  peerColor?(name: string): string | undefined;
  /**
   * Token-usage series for a peer (§12.8, FR-103); undefined when the agent's type
   * has no token accounting configured. Read-only, in-memory ⇒ synchronous.
   */
  tokenSeries?(name: string): TokenSeries | undefined;
  /**
   * An agent's session clock as DURATIONS (§5.5, FR-197): how long its session has
   * been up and how long it has shown no sign of life, plus which signal was the
   * newest. Durations, not stamps, on purpose — the panel runs on the VIEWER's
   * clock, and a browser whose clock is minutes off the server's would otherwise
   * render an uptime that is quietly wrong. `observedForMs` is how long this
   * coordinator has been watching, so an absent `quietForMs` reads as "nothing
   * seen since it booted N ago" instead of "silent forever" (§10.34). Undefined
   * for a peer with no session (a user) or when the clock is not wired.
   */
  peerClock?(name: string): PeerClock | undefined;
  /**
   * Resolved WIP limit of an agent (§8.2, FR-104): the depth cap, or `null` when the
   * agent is exempt (`wipLimit:0`, operators, hub). The panel marks an agent whose
   * `queueDepth` has reached this cap (red name). Absent ⇒ no WIP marking.
   */
  wipLimitOf?(name: string): number | null;
  /**
   * Rendezvous view (§8.2, FR-105): the agents that are **waiting** (have an outgoing
   * reconnection intent — the "я жду" / ↑ marker) and **awaited** (are the target of
   * some intent — the "меня ждут" / ↓ marker). Absent ⇒ rendezvous disabled (no arrows).
   */
  rendezvousState?(): { readonly waiting: readonly string[]; readonly awaited: readonly string[] };
  /**
   * Federated peers the identity can see (§18.4, FR-144/FR-150): every actor of
   * every import the identity has a topology edge on — same edge rule as agents.
   * Absent ⇒ no federation configured.
   */
  remotePeers?(): readonly RemotePeerRow[];
}

/** A backward-cursor page of the transport log (§8.2, FR-48). */
export interface TransportPage {
  readonly records: readonly Signal[];
  readonly nextBefore?: string;
}

/**
 * Read-only transport observability port (T64, FR-48, §12.4) — the panel's view
 * of the SERVER-WIDE transport log (§8.2), agent↔agent included. Injected at
 * assembly like the dynamics above (orchestrator's TransportLog, structurally);
 * deliberately a separate capability from WebchatPorts: observation rights, not
 * the operator's agent-plane.
 */
export interface TransportObservability {
  /** Page backwards from `before` (exclusive) or from the newest record. */
  page(options?: { before?: string; limit?: number }): Promise<TransportPage>;
  /** Live feed of freshly routed records; returns the unsubscribe. */
  subscribe(listener: (record: Signal) => void): () => void;
}

/** Which lifecycle actions the panel may offer for a peer (FR-65). */
export interface PeerActions {
  /** A live session exists to tear down (graceful, FR-64). */
  readonly shutdown: boolean;
  /** A provision block exists to come back up after the teardown. */
  readonly reload: boolean;
  /**
   * Pause/resume is available for this peer (§16.6, FR-120). Unlike shutdown it
   * does NOT require a live session — pause is a transport flag, so the menu item
   * works on a `down` agent too. Optional: absent ⇒ the item does not render (an
   * older server, or pause not wired).
   */
  readonly pause?: boolean;
}

/**
 * Narrow lifecycle port (T85, FR-65, §12.4): shutdown/reload of the operator's
 * TOPOLOGY-NEIGHBOR agents only — a deliberate §10.12 capability extension
 * (operator decision T85), NOT the operator-plane (§8.5): no kill/provision/
 * queue-edit/routine rights ever reach the panel. Injected at assembly; absent
 * ⇒ the endpoints answer 503 and no buttons render.
 */
export interface WebchatLifecycle {
  /** Action availability for a peer (drives the UI buttons, FR-65). */
  actions(name: string): PeerActions;
  /** Graceful kill (FR-64): teardown strategy first, hard kill as fallback. */
  shutdown(name: string): Promise<AgentStatus>;
  /** Graceful restart (FR-64): teardown, then provision through the lane. */
  reload(name: string): Promise<AgentStatus>;
  /**
   * Pause / resume the peer's communications (§16.5, FR-119): the DESIRED state,
   * idempotent, never a toggle — two panel tabs must not invert each other (§16.4).
   * Resolves to the flag as it now stands. Optional: absent ⇒ the endpoint answers
   * 503 and no menu item renders.
   */
  pause?(name: string, paused: boolean): Promise<boolean>;
  /** The peer's slash commands (FR-66 config ∪ FR-67 internal) — the dropdown. */
  commands(name: string): readonly string[];
  /** Run an ALLOWED slash command; resolves to the console output as-is. */
  runCommand(name: string, slash: string): Promise<string>;
  /**
   * Slash-command to a group/tag/agent INTERSECTION (§15.8, FR-115): resolve the
   * selectors, dispatch to each agent in the intersection that is a topology
   * NEIGHBOUR of the bound operator (non-neighbour → COMMAND_DENIED in the
   * fan-out, §10.2). Optional: absent ⇒ /api/agents/command answers 503.
   */
  commandFanout?(slash: string, selectors: readonly string[]): Promise<CommandFanoutOutcome>;
  /**
   * Live console snapshot (FR-102): the peer's VISIBLE terminal pane as-is —
   * a read-only capture, the text form of what the console shows. Optional:
   * absent ⇒ /api/agents/:name/screen answers 503 (like the port as a whole).
   */
  screen?(name: string): Promise<string>;
  /**
   * Interactive console (§12.9, FR-160): attaches to the peer's pane and hands
   * back a live terminal — output streams through `handlers`, keystrokes go the
   * other way through `write`. This is the panel's REAL console, replacing the
   * polled snapshot mode; the snapshot port stays for the text capture.
   * Optional: absent ⇒ the console socket refuses with UNAVAILABLE.
   */
  console?(name: string, handlers: ConsoleHandlers): Promise<ConsoleAttachment>;
}

/** Callbacks of a live console attachment (§12.9) — the socket's two directions. */
export interface ConsoleHandlers {
  /** Pane output as raw bytes, in order. */
  readonly onData: (bytes: Uint8Array) => void;
  /** The pane is gone (session killed/restarted) or the attachment was closed. */
  readonly onExit: () => void;
}

/**
 * A live console (§12.9, FR-160) — structurally the tmux package's attachment,
 * redeclared here so webchat stays free of a tmux dependency (§8 layering).
 */
export interface ConsoleAttachment {
  /** Pane geometry: the browser MIRRORS it and never resizes the agent's window. */
  readonly cols: number;
  readonly rows: number;
  /** Opening frame — scrollback, screen and cursor, written into a fresh emulator. */
  readonly screen: string;
  /** Type bytes into the pane exactly as a keyboard would. */
  write(bytes: Uint8Array): void;
  /** Detach. Idempotent; `onExit` follows. */
  close(): void;
}

/**
 * Result of a command-fanout (§15.8, FR-115) — structurally the orchestrator's
 * `CommandFanoutResult`, redeclared here so webchat stays free of an orchestrator
 * dependency. `ok:false` is an input error (400); `ok:true` carries the per-agent
 * aggregate (individual failures live in `fanout[].code`, not the top level).
 */
export type CommandFanoutOutcome =
  | {
      readonly ok: true;
      readonly kind: "command-fanout";
      readonly slash: string;
      readonly selectors: readonly string[];
      readonly targets: readonly string[];
      readonly fanout: readonly {
        readonly to: string;
        readonly ok: boolean;
        readonly output?: string;
        readonly code?: string;
      }[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string };
