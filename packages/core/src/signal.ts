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
  /** Producing channel or routine, if any (§5.3); {@link isHumanOrigin} reads it. */
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
   * Does this turn ask for an answer? Absent ⇒ the DEFAULT OF THE KIND: a
   * "message" asks, a "reaction" notifies (§13.7, §19.6). Set, it overrides that
   * default in either direction, and it is the only switch that does.
   *
   *   - `true` on a reaction (FR-164): the operator configured a reaction whose
   *     text is real WORK (§19.2), so the turn renders exactly like a message —
   *     one materialized message.json, exactly one reply contract (§10.29).
   *   - `false` on a message (FR-180): a RECEIPT — "принято", "ok", "closed" —
   *     that must not start an ack chain. The receiver gets attribution, payload
   *     and "no reply is expected"; no inbox folder, no contract named at all,
   *     and no reply window armed (FR-45/FR-47/FR-105). Between agents there was
   *     no free receipt before this flag: `kind:"ack"` is rejected (the kind set
   *     is closed) and the injected contract asks for an answer even when the
   *     text says "don't answer", so a disciplined receiver answered anyway —
   *     three rounds of it, in the live measurement that produced §13.7.
   *
   * A transport modifier, like `raw` — never a kind of its own: what changes is
   * the instruction the agent reads, not the routing, the queue or the receipt.
   * A new terminal kind would have to be taught to every switch on kind (router,
   * dedup, history, connectors, channels, federation) to change one instruction.
   */
  readonly expectsReply?: boolean;
}

/**
 * Is this signal a NOTICE — delivered as a turn, but asking for nothing (§13.7,
 * §19.6)? The rule is one line: the flag when the producer set it, otherwise the
 * default of the kind (a message asks, a reaction notifies).
 *
 * The predicate lives here because four layers must agree on it byte-for-byte:
 * the render (which must not name a reply path — §10.29/T267: naming one is
 * asking), the exchange (which must not create a folder for an answer nobody
 * wants), the nudger (which must not scrape the console of a receiver that owes
 * nothing — that is the ack loop coming back through the door §13.7 closed) and
 * the rendezvous coordinator (which must not resurrect a refused notice).
 */
export function isNotificationOnly(signal: Signal): boolean {
  if (signal.expectsReply !== undefined) return !signal.expectsReply;
  return signal.kind === "reaction";
}

/**
 * Origins a HUMAN typed into (§5.3): the panel, a channel bridge, an agent's own
 * console, the operator CLI. Everything else that stamps `origin` is machinery —
 * an agent's file-contract answer (`exchange`), its outbox, a captured console
 * (`raw`/`tmux-fallback`), a broadcast copy, a federation hop, a reaction notice —
 * and an MCP `send` stamps nothing at all.
 *
 * The distinction matters wherever `replyTo` is read as INTENT rather than as
 * plumbing (FR-178/FR-179): every agent answer carries `replyTo` to correlate
 * itself with the question, while a human's `replyTo` means "I chose to quote
 * this". T294 learned the difference the hard way — the file-contract answer path
 * stamps `origin: "exchange"`, so "origin is set" was not the test it looked like.
 *
 * An unknown origin counts as machinery: a new channel simply adds itself here.
 */
export const HUMAN_ORIGINS: ReadonlySet<string> = new Set([
  "webchat", // the panel's own send (§12.4)
  "web", // the web channel bridge (§7.1)
  "telegram",
  "slack",
  "console", // typed into the agent's terminal by a person (FR-170)
  "operator-plane", // the operator CLI
]);

/** Did a person write this signal, as opposed to the transport (see {@link HUMAN_ORIGINS})? */
export const isHumanOrigin = (origin: string | undefined): boolean =>
  origin !== undefined && HUMAN_ORIGINS.has(origin);

/**
 * The origin the deferred self-chain stamps (§21.3): an item the agent scheduled
 * for ITSELF, fired by the tick. Not a channel and not a human — machinery the
 * agent itself armed.
 */
export const SCHEDULE_ORIGIN = "schedule";

/**
 * Is this signal an agent's OWN scheduled item (§21, FR-199)? — self-addressed
 * (`from == to`, which `schedule_self` guarantees structurally: it has no `to`
 * parameter) and stamped by the scheduler.
 *
 * This is the one thing the transport gates let through unconditionally: an agent
 * that fenced its own sequence with `/pause` (FR-198) must still receive the
 * sequence, and a WIP cap that exists to protect it from OTHER agents must not
 * refuse what it planned for itself. Everything else a pause refuses stays
 * refused — including the agent's ordinary self-delivery (§16.2).
 */
export function isSelfScheduled(signal: {
  readonly from: string;
  readonly to: string;
  readonly origin?: string;
}): boolean {
  return signal.from === signal.to && signal.origin === SCHEDULE_ORIGIN;
}
