// Idle auto-teardown (FR-92, §5.1) — retire an agent the system raised once it
// has been inactive long enough. "Inactive" = continuously idle (§5.1) with no
// messages routed to or from it (the transport, §8.2) for the configured window.
// Only SYSTEM-RAISED sessions (provisioned by TEAMAI, AgentState.origin, §5.1) are
// reaped: a hand-started / attach-only agent is left alone — we retire what we
// raised. New queued work later lazy-revives the agent (FR-51), so this is a
// bring-up/idle-down cycle, not a permanent shutdown.
//
// The clock is the last routed message (noteActivity, fed by the router's
// onRouted) or the last moment the agent was NOT idle (a turn in flight is
// activity — the busy reset below). When the window elapses the sweeper calls the
// injected teardown(), which the server wires to submit a RE-VALIDATING op to the
// session's control lane (§8.5) so a turn is never interrupted (idle + empty
// queue + still-stale checked at execution). The sweeper itself never touches
// tmux — it owns timing/eligibility only, like the down-probe (§8.2).

import type { AgentStatus } from "@teamai/core";

/** The 1h default window (FR-92) — `teardown.idle: true` resolves to this. */
export const IDLE_TEARDOWN_DEFAULT_MS = 60 * 60 * 1000;

export interface IdleTeardownTarget {
  /** Participant name — the activity-clock key (router from/to, §8.2). */
  readonly name: string;
  /** Resolved inactivity window in ms (teardown.idle, §5.1). */
  readonly idleMs: number;
  /** Live status (§5.1). */
  status(): AgentStatus;
  /** Was the live session raised by us (provision) rather than attached? (§5.1) */
  isSystemRaised(): boolean;
  /**
   * Perform the graceful teardown. The server wires this to a re-validating
   * control-lane op (idle + empty queue + still stale), so it never interrupts a
   * turn. Errors are swallowed by the sweeper (best-effort, like the §5.4 sweep).
   */
  teardown(): Promise<void>;
}

export interface IdleTeardownOptions {
  readonly targets: readonly IdleTeardownTarget[];
  /** Sweep cadence (NFR-10); default 60000. */
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class IdleTeardownSweeper {
  readonly #targets: readonly IdleTeardownTarget[];
  readonly #byName: Map<string, IdleTeardownTarget>;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Per-agent last activity (a routed message OR the last non-idle observation). */
  readonly #last = new Map<string, number>();
  /** Agents with a teardown op in flight — don't pile the lane up across ticks. */
  readonly #inFlight = new Set<string>();

  constructor(options: IdleTeardownOptions) {
    this.#targets = options.targets;
    this.#byName = new Map(options.targets.map((t) => [t.name, t]));
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Record transport activity for a participant (router onRouted, §8.2). */
  noteActivity(name: string): void {
    if (this.#byName.has(name)) this.#last.set(name, this.#now());
  }

  /**
   * Whether `name` has been inactive for at least its window — the freshest check,
   * used by the control-lane op to skip a teardown a just-arrived message obsoleted.
   */
  isStale(name: string): boolean {
    const target = this.#byName.get(name);
    if (target === undefined) return false;
    const last = this.#last.get(name);
    if (last === undefined) return false;
    return this.#now() - last >= target.idleMs;
  }

  /** One sweep pass over all targets. */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const target of this.#targets) {
      // Not idle (busy/down) or not ours → not eligible; keep the clock fresh so
      // the window starts counting from the moment it next becomes idle-and-ours.
      if (target.status() !== "idle" || !target.isSystemRaised()) {
        this.#last.set(target.name, now);
        continue;
      }
      const last = this.#last.get(target.name);
      if (last === undefined) {
        this.#last.set(target.name, now); // start the clock at first eligible sight
        continue;
      }
      if (now - last < target.idleMs) continue; // still within the window
      if (this.#inFlight.has(target.name)) continue; // one op at a time per agent
      this.#inFlight.add(target.name);
      void this.#fire(target);
    }
  }

  async #fire(target: IdleTeardownTarget): Promise<void> {
    try {
      await target.teardown();
    } catch {
      // best-effort; a failed reap is retried on the next tick
    } finally {
      this.#inFlight.delete(target.name);
    }
  }

  /** Production loop: sweep, then sleep, until aborted. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      if (!signal.aborted) await this.#sleep(this.#intervalMs);
    }
  }
}
