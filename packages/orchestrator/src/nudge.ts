// Reply-nudge (§8.2, FR-45, T58). Live finding: an agent's model can finish a turn
// by printing its answer to the terminal without ever calling `send` — the human in
// the channel gets nothing. The router (the single delivery point, §8.2) reports
// every routed send here; the agent's dispatcher marks the turn window and asks
// afterwards whether the agent sent ANYTHING back to the message's sender. If not,
// ONE nudge is enqueued: kind "nudge", a deterministic id (`<id>:nudge`) so the
// done/-dedup window (§10.9) suppresses repeats across redeliveries, and a payload
// naming the exact send() call. Nudges expect no reply (kind ≠ "message") — a nudge
// never nudges, so there is no loop.
//
// Scope (T61): the turn window opens for EVERY `kind="message"` — operator AND
// inter-agent (live finding: a peer's console answer was lost the same way) —
// except messages that are themselves scrapes (`origin:"tmux-fallback"`), so a
// fallback hop never demands a reply and two console-only agents cannot ping-pong
// scrapes. The nudge stays operator-only: nudging an agent for every unanswered
// peer message would FORCE a reply to every reply — the ack ping-pong §8.2 forbids.

import type { Signal } from "@muxeon/core";

export interface NudgerOptions {
  /** Operator nodes (§7.5) — only operator-origin messages expect a reply. */
  readonly isOperator: (name: string) => boolean;
  /** router.route — the nudge travels the normal delivery path (§10.2). */
  readonly route: (message: Signal) => Promise<unknown>;
  /** Clock for the nudge's ts; injectable for tests. Default Date.now. */
  readonly now?: () => number;
}

/** The reminder payload — mirrors the render reply-hint (T57) but imperative. */
export function nudgePayload(message: Signal): string {
  return [
    `You received message ${message.id} from ${message.from} and finished your turn without replying.`,
    "Text printed to the terminal does NOT reach the sender.",
    `Reply NOW via the muxeon MCP tool: send(to="${message.from}", replyTo="${message.id}") with your answer as plain-text payload.`,
  ].join(" ");
}

export class ReplyNudger {
  readonly #isOperator: (name: string) => boolean;
  readonly #route: (message: Signal) => Promise<unknown>;
  readonly #now: () => number;
  // "from→to" → count of routed sends; the dispatcher snapshots it at injection
  // and compares after the turn. One dispatcher per session (§10.8) → race-free.
  readonly #sendCounts = new Map<string, number>();
  readonly #marks = new Map<string, number>();

  constructor(options: NudgerOptions) {
    this.#isOperator = options.isOperator;
    this.#route = options.route;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Does this delivered message expect a reply at all (§8.2, T61)? Any real
   * message does — operator or peer agent — but never a scrape: a
   * `tmux-fallback` message opening its own window would let two console-only
   * agents ping-pong scrapes forever.
   */
  expectsReply(message: Signal): boolean {
    return message.kind === "message" && message.origin !== "tmux-fallback";
  }

  /** Router hook: a send was routed (called for EVERY successful route, §8.2). */
  recordSend(from: string, to: string): void {
    const key = `${from} ${to}`;
    this.#sendCounts.set(key, (this.#sendCounts.get(key) ?? 0) + 1);
  }

  /** Dispatcher hook, before inject: open the turn window for agent→sender. */
  beginTurn(agent: string, message: Signal): void {
    if (!this.expectsReply(message)) return;
    const key = `${agent} ${message.from}`;
    this.#marks.set(key, this.#sendCounts.get(key) ?? 0);
  }

  /**
   * Dispatcher hook, after a done turn: the agent never sent to the message's
   * sender within the window → FIRST try the console-fallback (FR-47, T60): a
   * scraped terminal answer is routed to the sender as the agent's reply
   * (origin "tmux-fallback", honest about the mechanism) and SUPPRESSES the
   * nudge. Nothing scrapeable → nudge (FR-45) — but ONLY for operator-origin
   * messages: a peer message left unanswered (e.g. a pure ack, §8.2) earns
   * nothing. Both ids are deterministic (`<id>:scrape` / `<id>:nudge`) so a
   * duplicate enqueue (crash between complete and this hook) collapses in the
   * dedup window (§10.9).
   */
  async afterTurn(
    agent: string,
    message: Signal,
    scrape?: () => Promise<string | null>,
  ): Promise<void> {
    if (!this.expectsReply(message)) return;
    const key = `${agent} ${message.from}`;
    const mark = this.#marks.get(key);
    this.#marks.delete(key);
    if (mark === undefined) return; // no window opened (e.g. recovery edge) — skip
    if ((this.#sendCounts.get(key) ?? 0) > mark) return; // the agent replied

    const scraped = scrape === undefined ? null : await scrape().catch(() => null);
    if (scraped !== null && scraped.length > 0) {
      await this.#route({
        id: `${message.id}:scrape`,
        from: agent,
        to: message.from,
        kind: "message",
        ts: this.#now(),
        replyTo: message.id,
        payload: scraped,
        origin: "tmux-fallback",
      });
      return;
    }

    if (!this.#isOperator(message.from)) return; // peers are never nudged (T61)
    await this.#route({
      id: `${message.id}:nudge`,
      from: message.from,
      to: agent,
      kind: "nudge",
      ts: this.#now(),
      replyTo: message.id,
      payload: nudgePayload(message),
    });
  }
}
