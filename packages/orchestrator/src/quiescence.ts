// Quiescence (§21.10, FR-200): "is this agent OBSERVABLY done", as opposed to
// "does its status say idle". The two differ exactly where it hurts — a CLI that
// prints its prompt between phases reads as idle while the work goes on, and a
// chain item that fires on that reading types into the middle of a live turn.
//
// So the evidence is what the agent VISIBLY does, not what it claims:
//
//   * the console pane — unchanged for the whole window (the fine-grained signal;
//     every agent has one, no config needed);
//   * the token gauge (§12.8) — unmoved for the whole window, where accounting is
//     on. Coarse (one sample per `tokens.sampleEvery`), so it corroborates rather
//     than leads: a gauge that MOVED inside the window is proof of work even if
//     the pane happened to redraw to the same bytes;
//   * the session status — `busy` is never quiet. The status can be wrong in one
//     direction only here: it may say idle too early (what the pane guards
//     against), and if it is stuck at busy the item's own timeout ends the wait.
//
// The tracker keeps one fingerprint per agent and answers "how long has it been
// still". It is deliberately NOT a subscription: the scheduler asks while an item
// waits and nobody pays for the probe otherwise.

import type { AgentStatus } from "@muxeon/core";

export interface QuiescenceDeps {
  /** The agent's visible pane — the same capture the console and detect use. */
  capture(session: string): Promise<string>;
  /** Live status; `busy` short-circuits to "not quiet". */
  status(agent: string): AgentStatus | undefined;
  /** Latest token gauge (§12.8), or undefined when the type has no accounting. */
  tokens?(agent: string): number | undefined;
  now?(): number;
}

/** One agent's last observation — the fingerprint the next probe is compared to. */
interface Mark {
  readonly fingerprint: string;
  /** When the fingerprint was FIRST seen — the stillness clock starts here. */
  readonly since: number;
}

/**
 * A cheap hash of the pane. The pane is small (a screenful) and the comparison is
 * per waiting item per tick, so the point is not speed but not holding screens of
 * other agents' consoles in memory — a fingerprint is enough to answer "changed?".
 */
function fingerprint(pane: string, tokens: number | undefined): string {
  let hash = 5381;
  for (let i = 0; i < pane.length; i += 1) hash = (hash * 33) ^ pane.charCodeAt(i);
  return `${hash >>> 0}:${pane.length}:${tokens ?? ""}`;
}

export class QuiescenceTracker {
  readonly #deps: QuiescenceDeps;
  readonly #now: () => number;
  readonly #marks = new Map<string, Mark>();

  constructor(deps: QuiescenceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * How long the agent has been observably still, in ms — `0` while it is busy or
   * has just changed, `undefined` when nothing can be observed at all (no session
   * to capture). Each call takes ONE fresh observation, so the resolution is the
   * caller's cadence.
   */
  async quietMs(agent: string, session: string): Promise<number | undefined> {
    const at = this.#now();
    const status = this.#deps.status(agent);
    if (status === "down") {
      // A down agent is still by definition and nothing can be typed into it; the
      // caller decides what that means (a message item may still be queued).
      this.#marks.delete(agent);
      return undefined;
    }
    let pane: string;
    try {
      pane = await this.#deps.capture(session);
    } catch {
      return undefined; // the pane could not be read — say "unknown", never "quiet"
    }
    const next = fingerprint(pane, this.#deps.tokens?.(agent));
    const mark = this.#marks.get(agent);
    if (mark === undefined || mark.fingerprint !== next) {
      this.#marks.set(agent, { fingerprint: next, since: at });
      return 0; // something moved (or this is the first look — never assume stillness)
    }
    // Unchanged since `mark.since` — but a busy session is never quiet, whatever
    // the pane shows: a turn in flight is work by definition (§5.1).
    return status === "busy" ? 0 : Math.max(0, at - mark.since);
  }

  /** Forget an agent (session gone / chain finished) — the next look starts fresh. */
  forget(agent: string): void {
    this.#marks.delete(agent);
  }
}
