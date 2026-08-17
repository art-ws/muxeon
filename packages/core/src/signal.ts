// Signal — the generic envelope for an event/prompt directed at a participant
// (§2, §5.3). A Message is the baseline special case (see ./message). New `kind`s
// are forward-compatible additions (R3); baseline has only "message".
//
// Media and files are NOT inlined: `payload` carries opaque blob references that
// are resolved only under <root>/blobs/ with realpath-containment (§5.3, §8.7),
// keeping queue records small. `core` performs no I/O.

// Baseline ships "message"; "reaction" is the first forward-compat addition
// (FR-25b/S, §3.2): a connector that does not support a kind may ignore it —
// ignoring MUST complete the delivery, never block the operator queue (§10.9).
// "nudge" (FR-45, T58) is SYSTEM-generated only — the reply reminder the
// dispatcher enqueues after a reply-less turn; producers cannot send it
// (admin/MCP validation rejects it) and nudges never expect replies.
// "rendezvous" (FR-105) is likewise SYSTEM-only — the resume-after-WIP-strike
// notice ("sender A is free — reach out to it") the coordinator sends to a target
// B; it rides the WIP-gate bypass (router `bypassWip`, allowed for THIS kind only)
// and, like a nudge, opens no reply-window of its own (§8.2).
// "broadcast" (FR-110, §15.4) is SYSTEM-only too — the router's fan-out stamps it
// on each per-member copy when a `to` names a group/tag. Producers cannot send it
// (they address the group/tag with kind:"message"; admin/MCP validation rejects
// "broadcast" as input). Like a nudge, a broadcast copy opens NO reply window — the
// reply-nudge ledger arms only on "message" (nudge.ts) — so a group/tag is a purely
// one-directional channel; the copies carry `origin:"broadcast:<target>"`.
export type SignalKind = "message" | "reaction" | "nudge" | "rendezvous" | "broadcast";

export interface Signal {
  /** Idempotency key for dedup (§10.9); reused by retrying producers (§5.3). */
  readonly id: string;
  /** Topology identity of the sender (§7, §10.2). */
  readonly from: string;
  /** Topology identity of the recipient (§7, §10.2). */
  readonly to: string;
  /** Signal kind; "message" is the baseline (§2). */
  readonly kind: SignalKind;
  /** Producer timestamp, unix milliseconds. */
  readonly ts: number;
  /** Opaque payload (text and/or blob references, §5.3). */
  readonly payload: unknown;
  /** `id` of the signal being replied to, if any (§8.3 attribution). */
  readonly replyTo?: string;
  /** Producing channel or routine, if any (§5.3). */
  readonly origin?: string;
  /**
   * Raw transport mode (§14, FR-88): an operator→agent turn whose payload is
   * injected into the terminal VERBATIM — no attribution preamble, no exchange
   * instruction, no inbox projection — and whose reply is the console captured
   * as-is by the configured rule (§14.2). A transport modifier, not a kind: the
   * captured reply travels back as an ordinary `kind:"message"` (origin "raw").
   * Honored only by a tmux agent's dispatcher; the egress pseudo-session ignores
   * it (a human peer has no console to capture).
   */
  readonly raw?: boolean;
  /**
   * Explicit answer opt-in for a non-message kind (§19.6, FR-164). A reaction
   * notification is a notice by default — no inbox projection, no reply contract,
   * "no answer required" spelled out — because the operator's default reaction
   * texts are notices and an answer chain would be pure noise (§10.30). When the
   * operator configures a reaction whose text is real WORK (`expectsReply: true`,
   * §19.2), this flag rides along and the turn is rendered exactly like a message:
   * one materialized message.json and exactly one reply contract (§10.29).
   *
   * A transport modifier, like `raw` — never a kind of its own: what changes is
   * the instruction the agent reads, not the routing, the queue or the receipt.
   * Meaningless on `kind:"message"` (a message always asks) and ignored there.
   */
  readonly expectsReply?: boolean;
}

/**
 * Is this signal a NOTICE — delivered as a turn, but asking for nothing (§19.6,
 * FR-164)? Only a reaction can be one, and only until the operator opts that
 * reaction into a real turn. The predicate lives here because two layers must
 * agree on it byte-for-byte: the render (which must not name a reply path —
 * §10.29/T267: naming one is asking) and the exchange (which must not create a
 * folder for an answer nobody wants).
 */
export function isNotificationOnly(signal: Signal): boolean {
  return signal.kind === "reaction" && signal.expectsReply !== true;
}
