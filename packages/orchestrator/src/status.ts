// AgentStatus state-machine (§5.1) — the source for get_status (§8.1). `down` = no
// tmux session; idle/busy come from the adapter's detect (§5.2). One AgentState per
// session, owned by the orchestrator.
//
// The same object carries the session CLOCK (§5.5, FR-194): when the current
// session came up and when the agent was last seen doing anything. A status alone
// says WHAT an agent is; the clock says FOR HOW LONG — an `idle` agent quiet for
// six hours and one quiet for six seconds read identically without it.

import type { AgentStatus } from "@muxeon/core";

// Allowed non-identity transitions (§5.1):
//   down → idle         (comes up: attach / provision / restart)
//   idle → busy | down  (message injected | session lost)
//   busy → idle | down  (turn complete §5.2 | session lost §5.1, FR-16b)
// down → busy is illegal — an agent must come up idle before it can be busy.
const ALLOWED: Record<AgentStatus, readonly AgentStatus[]> = {
  down: ["idle"],
  idle: ["busy", "down"],
  busy: ["idle", "down"],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}

/**
 * How the LIVE session came up (§5.1, FR-92): `system` — Muxeon provisioned it
 * (provision/restart/reload/auto-revive); `external` — we attached to a session
 * the operator started, or none is up yet. Idle auto-teardown only retires what
 * we raised (`system`), so a hand-started agent is never reaped. Every come-up
 * path sets it explicitly (provision ⇒ system, attach ⇒ external); the default
 * `external` covers a startup attach to a live session.
 */
export type SessionOrigin = "system" | "external";

/**
 * What Muxeon can WITNESS as a sign of life (§5.5, FR-195). All four are
 * observations of the coordinator, never claims about the agent's inner work:
 *
 *  - `session`  — the session came up (`down → idle`);
 *  - `turn`     — a turn started or ended (`idle ↔ busy`, §5.2);
 *  - `transport`— a signal was routed to or from the agent (§8.2);
 *  - `tokens`   — the console's token gauge MOVED between two samples (§12.8).
 *
 * `tokens` is the only one that sees work Muxeon did not cause: an agent typing
 * away on its own local task moves its gauge without a single routed message.
 */
export type ActivitySource = "session" | "turn" | "transport" | "tokens";

/** The clock as a reader sees it — absolute stamps, no derived durations. */
export interface AgentClock {
  /** When the LIVE session came up (unix ms); absent when down or unknown. */
  readonly startedAt?: number;
  /** Newest activity stamp across all sources; absent when nothing was witnessed. */
  readonly lastActivityAt?: number;
  /** Which source produced {@link lastActivityAt}. */
  readonly lastActivity?: ActivitySource;
  /** Per-source stamps — the breakdown behind the newest one. */
  readonly signals: Readonly<Partial<Record<ActivitySource, number>>>;
}

/**
 * The clock a surface reports (§5.5): absolute stamps PLUS the durations they
 * imply, so a reader needs no clock of its own to answer "how long".
 */
export interface AgentClockView extends AgentClock {
  /** now − startedAt; absent exactly when `startedAt` is. */
  readonly uptimeMs?: number;
  /** now − lastActivityAt — how long the agent has been quiet; absent with the stamp. */
  readonly quietForMs?: number;
  /**
   * When THIS coordinator started watching. An absent `lastActivityAt` means
   * "nothing witnessed since then" — not "never" (§10.34): the clock is an
   * observation, and a coordinator restart is where the observation begins.
   */
  readonly observedSince: number;
}

export class AgentState {
  #status: AgentStatus;
  #origin: SessionOrigin;
  #startedAt: number | undefined;
  readonly #signals = new Map<ActivitySource, number>();
  readonly #now: () => number;

  constructor(
    initial: AgentStatus = "down",
    origin: SessionOrigin = "external",
    now: () => number = Date.now,
  ) {
    this.#status = initial;
    this.#origin = origin;
    this.#now = now;
  }

  get status(): AgentStatus {
    return this.#status;
  }

  /** Whether the live session was raised by Muxeon vs attached (§5.1, FR-92). */
  get origin(): SessionOrigin {
    return this.#origin;
  }

  /** Record how the current session came up — set on every come-up path (§5.1). */
  setOrigin(origin: SessionOrigin): void {
    this.#origin = origin;
  }

  /** When the live session came up (§5.5); `undefined` while down or unknown. */
  get startedAt(): number | undefined {
    return this.#startedAt;
  }

  /**
   * Seed `startedAt` with the session's REAL birth time (§5.5, FR-194) — the
   * composition root reads it off tmux (`#{session_created}`) wherever the
   * session predates our knowledge of it: a startup attach, or a hand-started
   * session the liveness probe finds (FR-93). A transition stamp would report the
   * moment we NOTICED instead, which for an attach can be days late. Ignored
   * while down (nothing is running) and when the value is unknown — an absent
   * stamp is honest, an invented one is not (§10.34).
   */
  markStarted(at: number | undefined): void {
    if (at === undefined || !Number.isFinite(at)) return;
    if (this.#status === "down") return;
    this.#startedAt = at;
  }

  /**
   * Witness a sign of life (§5.5, FR-195). Per-source monotone: a stamp never
   * moves backwards, so an out-of-order observation cannot make an agent look
   * quieter than it was.
   */
  noteActivity(source: ActivitySource, at: number = this.#now()): void {
    if (!Number.isFinite(at)) return;
    const previous = this.#signals.get(source);
    if (previous !== undefined && at <= previous) return;
    this.#signals.set(source, at);
  }

  /** The clock as stamps (§5.5) — no derived durations, no clock reading. */
  get clock(): AgentClock {
    const signals: Partial<Record<ActivitySource, number>> = {};
    let lastActivityAt: number | undefined;
    let lastActivity: ActivitySource | undefined;
    for (const [source, at] of this.#signals) {
      signals[source] = at;
      if (lastActivityAt === undefined || at > lastActivityAt) {
        lastActivityAt = at;
        lastActivity = source;
      }
    }
    return {
      ...(this.#startedAt !== undefined ? { startedAt: this.#startedAt } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(lastActivity !== undefined ? { lastActivity } : {}),
      signals,
    };
  }

  /** Applies a transition, throwing on an illegal one (§5.1). */
  to(next: AgentStatus): void {
    if (!canTransition(this.#status, next)) {
      throw new Error(`illegal status transition: ${this.#status} -> ${next}`);
    }
    const from = this.#status;
    this.#status = next;
    if (from === next) return; // identity (a reconcile that found nothing) is not news
    const at = this.#now();
    if (next === "down") {
      // The session is gone: there is no uptime to report, and dying is not work —
      // the last activity stamp stays where the agent's last real sign of life was.
      this.#startedAt = undefined;
      return;
    }
    if (from === "down") {
      // Came up. A composition root that knows the session's true birth time
      // overwrites this stamp right after (markStarted) — provision is the case
      // where "now" IS the truth.
      this.#startedAt = at;
      this.noteActivity("session", at);
      return;
    }
    this.noteActivity("turn", at); // idle ↔ busy — a turn boundary (§5.2)
  }
}

/** Fold a state's stamps into the reported view (§5.5) — durations against `now`. */
export function clockView(state: AgentState, observedSince: number, now: number): AgentClockView {
  const clock = state.clock;
  return {
    ...clock,
    ...(clock.startedAt !== undefined ? { uptimeMs: Math.max(0, now - clock.startedAt) } : {}),
    ...(clock.lastActivityAt !== undefined
      ? { quietForMs: Math.max(0, now - clock.lastActivityAt) }
      : {}),
    observedSince,
  };
}
