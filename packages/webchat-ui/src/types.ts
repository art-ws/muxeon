// Wire types of the webchat API (§12.4) — the UI is a plain JSON client of
// @teamai/webchat; these mirror its responses, they are not runtime imports
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
export type PeerKind = "agent" | "group" | "tag";

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
  readonly status: AgentStatus | null;
  readonly queueDepth: number;
  readonly unread: number;
  readonly lastMessage?: { readonly ts: number; readonly from: string; readonly preview: string };
  /**
   * CLIENT-side only (FR-63, not from the server): when the panel observed this
   * peer turn busy — feeds the chat-header "thinking…" timer.
   */
  readonly busySince?: number;
  /** Available lifecycle actions (FR-65) — drives the Shutdown/Reload buttons. */
  readonly actions?: { readonly shutdown: boolean; readonly reload: boolean };
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
}

export interface HistoryPage {
  readonly records: readonly ChatRecord[];
  readonly nextBefore?: string;
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
      readonly type: "status";
      readonly peer: string;
      readonly status: AgentStatus | null;
      readonly queueDepth: number;
      /** Depth ≥ WIP cap (FR-104); optional for backward-compat with an older server. */
      readonly atWipLimit?: boolean;
      /** Has an outgoing rendezvous intent — ↑ "я жду" (FR-105). */
      readonly waiting?: boolean;
      /** Is a rendezvous target — ↓ "меня ждут" (FR-105). */
      readonly awaited?: boolean;
    }
  | {
      readonly type: "queue-progress";
      readonly id: string;
      readonly to: string;
      readonly phase: Exclude<MessagePhase, "queued">;
    };

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
