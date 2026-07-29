// Rendezvous store (§8.2, FR-105) — the pure per-sender intent machine behind the
// resume-after-WIP-strike coordinator. Live finding: the WIP limit (FR-104) refuses
// A→B and DROPS the payload (the sender must retry), so agent dialogs can silently
// stall. Direction S (operator decision): when A→B is refused WIP_LIMIT, an intent
// (A→B) is queued under A; when A next goes idle the coordinator notifies the TARGET
// B ("A is free — send it your message") and opens a window for the counter-send
// B→A. The intent is dropped ONLY on an accepted B→A (`resolve`) or on reaching
// `maxAttempts` (`expireFront`) — there is no wall-clock TTL.
//
// This module is PURE (no fs, no router, no timers — the caller hands in the clock as
// `windowUntil`/`now`). The coordinator (rendezvous-coordinator.ts) drives it, sends
// the notices through the router, and persists snapshots (rendezvous-state.ts).

/** Serialisable per-sender state — what `state/rendezvous/<sender>.json` holds. Only
 * the durable fields (target + attempt count) are kept; the runtime phase/window are
 * rebuilt as `waiting` on seed (a notice sent before a restart is simply re-sent). */
export interface RendezvousFile {
  readonly version: 1;
  /** `[to, attempts]` per pending intent, in queue order. */
  readonly intents: readonly (readonly [to: string, attempts: number])[];
}

/** A pending reconnection for one sender A (the map key): A wants to reach `to` (=B). */
export interface RendezvousIntent {
  /** The target B — the agent A was refused delivery to (WIP_LIMIT). */
  readonly to: string;
  /** Notify rounds spent so far; each `markNotified` increments it, capped by maxAttempts. */
  readonly attempts: number;
  /** `waiting` — not yet notified this round; `notified` — B was pinged, window open. */
  readonly phase: "waiting" | "notified";
  /** Unix ms the notify window closes (valid when `phase === "notified"`; else 0). */
  readonly windowUntil: number;
}

interface Intent {
  to: string;
  attempts: number;
  phase: "waiting" | "notified";
  windowUntil: number;
}

/**
 * In-memory per-sender queue of rendezvous intents (FIFO with rotate-to-back). At
 * most one intent per (from,to) pair, and at most the FRONT intent is ever `notified`
 * (a sender has one open window at a time). One instance owned by the coordinator.
 */
export class RendezvousStore {
  readonly #bySender = new Map<string, Intent[]>();
  readonly #dirty = new Set<string>();

  /**
   * Register A→B on a WIP refusal (FR-104). Dedup is one-per-pair: a second refusal
   * for a live pair keeps the existing intent (attempts preserved) and returns false.
   * Returns true when a new intent was queued.
   */
  register(from: string, to: string): boolean {
    const list = this.#bySender.get(from) ?? [];
    if (list.some((i) => i.to === to)) return false;
    list.push({ to, attempts: 0, phase: "waiting", windowUntil: 0 });
    this.#bySender.set(from, list);
    this.#dirty.add(from);
    return true;
  }

  /** The front intent for a sender (the one eligible to notify/expire), or undefined. */
  front(from: string): RendezvousIntent | undefined {
    return this.#bySender.get(from)?.[0];
  }

  /**
   * Transition the front intent `waiting → notified`: bump attempts and arm the window
   * until `windowUntil`. Returns the target B just notified, or undefined when the
   * front is missing or not `waiting` (already notified ⇒ do not re-ping).
   */
  markNotified(from: string, windowUntil: number): string | undefined {
    const front = this.#bySender.get(from)?.[0];
    if (front === undefined || front.phase !== "waiting") return undefined;
    front.phase = "notified";
    front.attempts += 1;
    front.windowUntil = windowUntil;
    this.#dirty.add(from); // attempts changed — persist
    return front.to;
  }

  /**
   * An accepted counter-send B→A arrived (the goal): remove intent (from,to) wherever
   * it sits in A's queue. Returns true when an intent was removed.
   */
  resolve(from: string, to: string): boolean {
    const list = this.#bySender.get(from);
    if (list === undefined) return false;
    const i = list.findIndex((x) => x.to === to);
    if (i === -1) return false;
    list.splice(i, 1);
    if (list.length === 0) this.#bySender.delete(from);
    this.#dirty.add(from);
    return true;
  }

  /**
   * The front's notify window elapsed with no counter-send. Drop it when it has spent
   * `maxAttempts` rounds, else rotate it to the back of the queue (reset to `waiting`).
   * Returns the affected target + outcome for logging, or undefined when the front is
   * not a `notified` intent.
   */
  expireFront(
    from: string,
    maxAttempts: number,
  ): { readonly to: string; readonly outcome: "dropped" | "rotated" } | undefined {
    const list = this.#bySender.get(from);
    const front = list?.[0];
    if (list === undefined || front === undefined || front.phase !== "notified") return undefined;
    list.shift();
    this.#dirty.add(from);
    if (front.attempts >= maxAttempts) {
      if (list.length === 0) this.#bySender.delete(from);
      return { to: front.to, outcome: "dropped" };
    }
    front.phase = "waiting";
    front.windowUntil = 0;
    list.push(front); // rotate to the tail — retried on a later idle
    return { to: front.to, outcome: "rotated" };
  }

  /** True while the front intent's notify window is still open at `now` (guards re-notify). */
  windowOpen(from: string, now: number): boolean {
    const front = this.#bySender.get(from)?.[0];
    return front !== undefined && front.phase === "notified" && now < front.windowUntil;
  }

  /** True when the front intent is `notified` and its window has elapsed (ready to expire). */
  windowExpired(from: string, now: number): boolean {
    const front = this.#bySender.get(from)?.[0];
    return front !== undefined && front.phase === "notified" && now >= front.windowUntil;
  }

  /** Every sender with at least one pending intent (for the sweep). */
  senders(): readonly string[] {
    return [...this.#bySender.keys()];
  }

  /** A sender's intents in queue order (read-only view — for tests/inspection). */
  intents(from: string): readonly RendezvousIntent[] {
    return this.#bySender.get(from) ?? [];
  }

  /** Whether an intent (from,to) is currently queued. */
  has(from: string, to: string): boolean {
    return this.#bySender.get(from)?.some((i) => i.to === to) ?? false;
  }

  isDirty(from: string): boolean {
    return this.#dirty.has(from);
  }

  clearDirty(from: string): void {
    this.#dirty.delete(from);
  }

  /** Serialise a sender's queue (durable fields only) for persistence. */
  snapshot(from: string): RendezvousFile {
    const list = this.#bySender.get(from) ?? [];
    return { version: 1, intents: list.map((i) => [i.to, i.attempts] as const) };
  }

  /**
   * Seed a sender's queue from a loaded file (startup rehydrate). Every intent comes
   * back `waiting` (runtime phase/window are not persisted); dedup and non-negative
   * attempts are enforced defensively against a hand-edited/corrupt file.
   */
  seed(from: string, file: RendezvousFile | undefined): void {
    if (file === undefined) return;
    const list: Intent[] = [];
    for (const entry of file.intents) {
      const [to, attempts] = entry;
      if (typeof to !== "string" || to.length === 0) continue;
      if (list.some((i) => i.to === to)) continue;
      const a =
        typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0 ? attempts : 0;
      list.push({ to, attempts: a, phase: "waiting", windowUntil: 0 });
    }
    if (list.length > 0) this.#bySender.set(from, list);
  }
}
