// Wire types of the webchat API (§12.4) — the UI is a plain JSON client of
// @muxeon/webchat; these mirror its responses, they are not runtime imports
// (webchat-ui stays out of the §8 runtime graph).

export type AgentStatus = "idle" | "busy" | "down";

/** Where a sent message currently is in the recipient's queue (§5.3). */
export type MessagePhase = "queued" | "pending" | "cur" | "done" | "failed";

export interface BlobRef {
  readonly blob: string;
  readonly name?: string;
  readonly mime?: string;
  readonly size?: number;
}

/** The §5.3 envelope as the history/WS deliver it. */
export interface ChatRecord {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly ts: number;
  readonly payload: string | { readonly text?: string; readonly blobs?: readonly BlobRef[] };
  readonly replyTo?: string;
  readonly origin?: string;
  /** Raw transport mode (FR-88, §14): the bubble renders text as-is (monospace). */
  readonly raw?: boolean;
}

/** Addressable-peer kind (§15, FR-106..): an agent, or an input-only broadcast
 *  target — a hierarchical group or a flat tag. Absent ⇒ agent (backward-compat). */
export type PeerKind = "agent" | "group" | "tag" | "user";

/** A user peer's derived availability (§17.5, FR-133) — not a session status. */
export type Presence = "online" | "offline";

export interface PeerInfo {
  readonly name: string;
  /**
   * The peer kind (§15). Absent or "agent" ⇒ an ordinary agent (an old server
   * omits it). A "group"/"tag" is an INPUT-ONLY broadcast target: no live
   * status/queue/unread/lifecycle — the status/queueDepth/unread fields below
   * carry their neutral zero/null and no actions/commands are present.
   */
  readonly type?: PeerKind;
  /** The group this agent belongs to (§15, FR-106) — its parent in the sidebar tree. */
  readonly group?: string;
  /** The tags this agent carries (§15, FR-107) — flat broadcast memberships. */
  readonly tags?: readonly string[];
  /** A group's parent group (§15) — undefined for a top-level (root) group. */
  readonly parent?: string;
  /** A group's/tag's fanned-out recipients (§15) — the broadcast subheader lists them. */
  readonly members?: readonly string[];
  /** Session status; a FEDERATED agent may read "unknown" (§18.4/§10.27). */
  readonly status: AgentStatus | "unknown" | null;
  /**
   * A user peer's presence (§17.5, FR-133): shown as a dot in place of the agent
   * status dot — a human has no session, so `status` is null for them. A
   * FEDERATED user may read "unknown" (§18.4).
   */
  readonly presence?: Presence | "unknown";
  /** Federated peer only (§18.4, FR-150): the import it arrived through. */
  readonly server?: string;
  /** Federated peer only (FR-139/FR-140): link reachability. */
  readonly link?: "up" | "down";
  /** Federated peer only (§18.4): why the projection reads "unknown" — the tooltip. */
  readonly reason?: "link-down" | "not-published" | "hop-down";
  /**
   * The configured display label of an agent or user (§7.1/§17.2, FR-156);
   * absent ⇒ the name is shown. Label only — `name` stays the address.
   */
  readonly title?: string;
  readonly queueDepth: number;
  readonly unread: number;
  readonly lastMessage?: { readonly ts: number; readonly from: string; readonly preview: string };
  /**
   * CLIENT-side only (FR-63, not from the server): when the panel observed this
   * peer turn busy — feeds the chat-header "thinking…" timer.
   */
  readonly busySince?: number;
  /** Available lifecycle actions (FR-65) + pause (FR-120) — drives the kebab menu. */
  readonly actions?: {
    readonly shutdown: boolean;
    readonly reload: boolean;
    /** Pause/resume offered for this peer (§16.6); absent on an older server. */
    readonly pause?: boolean;
  };
  /** Configured slash commands (FR-66) — the composer command buttons. */
  readonly commands?: readonly string[];
  /** Server-configured accent color (FR-73); absent ⇒ palette pick by name. */
  readonly color?: string;
  /** Has an outgoing rendezvous intent (FR-105) — the "я жду" / ↑ marker. */
  readonly waiting?: boolean;
  /** Is the target of a rendezvous intent (FR-105) — the "меня ждут" / ↓ marker. */
  readonly awaited?: boolean;
  /** Queue depth has reached the agent's WIP cap (FR-104) — the red name. */
  readonly atWipLimit?: boolean;
  /**
   * Operator-declared pause (§16, FR-120): the transport delivers nothing to this
   * agent. ORTHOGONAL to `status` — a paused agent can be idle, busy or down, so the
   * row shows the pause marker and keeps the real status in its tooltip.
   */
  readonly paused?: boolean;
}

/** Who placed one reaction, and when (§19.9) — the badge popup's list. */
export interface ReactionActor {
  readonly name: string;
  readonly ts: number;
}

/** The folded state of one reaction key on one message (§19.5, FR-162). */
export interface ReactionView {
  readonly key: string;
  readonly emoji: string;
  readonly count: number;
  readonly actors: readonly ReactionActor[];
  /** Placed by the logged-in viewer — the accent ring and the remove item (§19.9). */
  readonly mine: boolean;
}

/** One declared reaction of the catalog (§19.2, FR-161) — the picker's element. */
export interface ReactionItem {
  readonly key: string;
  readonly emoji: string;
  readonly label?: string;
  readonly category?: string;
}

/** One picker block (§19.2). */
export interface ReactionCategory {
  readonly name: string;
  readonly title?: string;
}

/** GET /api/reactions (§19.5): the closed palette plus the Recent order (§19.8). */
export interface ReactionCatalog {
  readonly categories: readonly ReactionCategory[];
  readonly items: readonly ReactionItem[];
  /** Keys ordered by global usage frequency — the block shown FIRST (FR-166). */
  readonly recent: readonly string[];
}

/** What became of the notification to an agent (§19.6) — shown in the badge popup. */
export interface ReactionNotify {
  readonly delivered: boolean;
  readonly code?: string;
}

export interface HistoryPage {
  readonly records: readonly ChatRecord[];
  readonly nextBefore?: string;
  /**
   * Reactions of the records on this page (§19.5), keyed by message id — BESIDE the
   * records, never inside them: an envelope stays verbatim wherever it is served.
   */
  readonly reactions?: Readonly<Record<string, readonly ReactionView[]>>;
}

/** One token histogram column: bucket-start unix ms + the slot's max gauge (§12.8). */
export interface TokenBucket {
  readonly t: number;
  readonly tokens: number;
}

/** The token-usage series for one agent (§12.8, FR-103) — mirrors the wire shape. */
export interface TokenSeries {
  /** Per-minute columns within the minute window (recent), ascending by time. */
  readonly minutes: readonly TokenBucket[];
  /** Per-hour columns behind the minute window (down to 24h), ascending by time. */
  readonly hours: readonly TokenBucket[];
  /** Latest sampled gauge. */
  readonly current: number;
  /** Unix ms of the latest sample (0 when none). */
  readonly updatedAt: number;
  /** Token ceiling for the health orb — 100% / red. */
  readonly maxThreshold: number;
}

export interface BlobMeta {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/** WS push events (§12.4). */
export type PanelEvent =
  | { readonly type: "message"; readonly record: ChatRecord }
  | { readonly type: "transport"; readonly record: ChatRecord }
  | { readonly type: "ack"; readonly id: string; readonly to: string }
  | { readonly type: "history-cleared"; readonly peer: string }
  | {
      /** A message's reactions changed (§19.5, FR-162): the folded state, not a delta. */
      readonly type: "reaction";
      readonly peer: string;
      readonly messageId: string;
      readonly reactions: readonly ReactionView[];
    }
  | {
      /** A journal row's reactions changed (§19.13, FR-182) — agent↔agent, read-only. */
      readonly type: "transport-reaction";
      readonly messageId: string;
      readonly reactions: readonly ReactionView[];
    }
  | {
      readonly type: "status";
      readonly peer: string;
      /** Absent for a federated user (their availability is `presence`). */
      readonly status?: AgentStatus | "unknown" | null;
      readonly queueDepth: number;
      /** Operator-declared pause (§16, FR-119); optional — an older server omits it. */
      readonly paused?: boolean;
      /** Depth ≥ WIP cap (FR-104); optional for backward-compat with an older server. */
      readonly atWipLimit?: boolean;
      /** Has an outgoing rendezvous intent — ↑ "я жду" (FR-105). */
      readonly waiting?: boolean;
      /** Is a rendezvous target — ↓ "меня ждут" (FR-105). */
      readonly awaited?: boolean;
      /** A user peer's presence (§17.5, FR-133); absent for agents. */
      readonly presence?: Presence | "unknown";
      /** Federated peer only (§18.4, FR-150): its import name. */
      readonly server?: string;
      /** Federated peer only (FR-139): link reachability. */
      readonly link?: "up" | "down";
      /** Federated peer only (§18.4): the `unknown` cause. */
      readonly reason?: "link-down" | "not-published" | "hop-down";
    }
  | {
      readonly type: "queue-progress";
      readonly id: string;
      readonly to: string;
      readonly phase: Exclude<MessagePhase, "queued">;
    };

/** One prompt on a shelf (§20.1, FR-183) — the server's record, verbatim. */
export interface PromptRecord {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly created: number;
  readonly updated: number;
}

/** One shelf of the rack: a name, a manual order and the prompts on it (§20.1). */
export interface PromptShelf {
  readonly id: string;
  readonly name: string;
  readonly created: number;
  readonly updated: number;
  readonly prompts: readonly PromptRecord[];
}

/** The signed-in user's whole rack (§20.1) — the shape every rack endpoint answers with. */
export interface PromptLibrary {
  readonly version: 1;
  readonly shelves: readonly PromptShelf[];
}

/** The peer's kind (§15) — an absent `type` is an ordinary agent (backward-compat). */
export function peerKind(peer: Pick<PeerInfo, "type">): PeerKind {
  return peer.type ?? "agent";
}

/** Payload text + blob refs, whatever the payload shape (§5.3 convention). */
export function payloadParts(payload: ChatRecord["payload"]): {
  text?: string;
  blobs: readonly BlobRef[];
} {
  if (typeof payload === "string") return { text: payload, blobs: [] };
  return {
    ...(payload.text !== undefined ? { text: payload.text } : {}),
    blobs: payload.blobs ?? [],
  };
}
