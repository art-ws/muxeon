// Liveness-probe sweeper (FR-93, §5.1): the mirror of the idle-teardown sweep — it
// periodically reconciles each agent's status with its live tmux session so a
// hand-started or hand-killed session is reflected WITHOUT a server restart (the
// per-turn down-probe FR-16b only catches busy→down; a session that came up or died
// outside a turn leaves the status stale). Like idle-teardown it owns
// timing/eligibility only and never touches tmux itself: the injected reconcile()
// runs on the session's control lane (§8.5), so the status mutation is serialized
// with turns (§10.1/§10.8) and never races the dispatcher. A busy agent is skipped —
// the per-turn down-probe (FR-16b) owns busy→down — and the reconcile re-checks busy
// at execution too, since a turn may start between the tick and the lane op.

import type { AgentStatus } from "@teamai/core";

export interface LivenessTarget {
  /** Participant name — the in-flight key. */
  readonly name: string;
  /** Live status (§5.1); a busy agent is skipped (FR-16b owns busy→down). */
  status(): AgentStatus;
  /** Reconcile status vs the live session, on the control lane (§8.5, FR-93). */
  reconcile(): Promise<void>;
}

export interface LivenessProbeOptions {
  readonly targets: readonly LivenessTarget[];
  /** Sweep cadence (NFR-10); default 2000. */
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Default sweep cadence (FR-93) — `has-session` ≈ 2ms/agent, so ~0.1% duty-cycle. */
export const LIVENESS_PROBE_DEFAULT_MS = 2000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class LivenessProbeSweeper {
  readonly #targets: readonly LivenessTarget[];
  readonly #intervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Agents with a reconcile op in flight — don't pile the lane up across ticks. */
  readonly #inFlight = new Set<string>();

  constructor(options: LivenessProbeOptions) {
    this.#targets = options.targets;
    this.#intervalMs = options.intervalMs ?? LIVENESS_PROBE_DEFAULT_MS;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** One sweep pass: reconcile every non-busy target whose op isn't already in flight. */
  async tick(): Promise<void> {
    for (const target of this.#targets) {
      if (target.status() === "busy") continue; // FR-16b owns busy→down — skip
      if (this.#inFlight.has(target.name)) continue; // one op at a time per agent
      this.#inFlight.add(target.name);
      void this.#fire(target);
    }
  }

  async #fire(target: LivenessTarget): Promise<void> {
    try {
      await target.reconcile();
    } catch {
      // best-effort; a failed reconcile is retried on the next tick
    } finally {
      this.#inFlight.delete(target.name);
    }
  }

  /**
   * Production loop: sleep, then sweep, until aborted. The sleep comes FIRST on
   * purpose — at boot every agent's status was just set by the attach probe (§5.1,
   * bootstrap step 6), so there is nothing to reconcile at t=0; the first drift can
   * only appear a cadence later. (This also keeps the always-on sweep from flipping
   * a freshly-booted agent before its first turn.) Reconcile-on-demand is `tick()`.
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.#sleep(this.#intervalMs);
      if (!signal.aborted) await this.tick();
    }
  }
}
