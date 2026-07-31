// User presence (§17.5, FR-133) — a DERIVED online/offline flag, not a status
// (§5.1 statuses describe a tmux session; a human has none, §17.5). The router is
// the single delivery point, so it sees every producer: each successfully routed
// message with `from = <user>` stamps that user's `lastActivity`, and the user
// counts as `online` while the stamp is younger than the TTL — a SLIDING window,
// every send pushes it forward.
//
// State is in-memory on purpose: presence is ephemeral, so after a restart
// everyone is offline until their first send. Appearing is instant (the router
// hook); fading out is a sweep on `presenceSweepMs` — ±cadence accuracy is
// enough for a "who is around" dot, and it costs one pass over a small map.

export type Presence = "online" | "offline";

export interface PresenceTrackerOptions {
  /** Online window in ms (§17.5, `server.presenceTtl`, default 15m at the caller). */
  readonly ttlMs: number;
  readonly now?: () => number;
  /**
   * Fired when a user's presence CHANGES (either way) — the panel/agent-plane push
   * hook (FR-133). Best-effort: a throwing listener must not break routing, so the
   * tracker swallows it.
   */
  readonly onChange?: (user: string, presence: Presence) => void;
}

export class PresenceTracker {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #onChange: ((user: string, presence: Presence) => void) | undefined;
  /** user → unix ms of their last successful outgoing send. */
  readonly #lastActivity = new Map<string, number>();
  /** Users currently reported as online — the diff source for onChange. */
  readonly #online = new Set<string>();

  constructor(options: PresenceTrackerOptions) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange;
  }

  /**
   * Records an outgoing send by `user` (§17.5): the window slides forward and, if
   * the user was offline, they appear INSTANTLY (no sweep latency).
   */
  note(user: string): void {
    this.#lastActivity.set(user, this.#now());
    if (!this.#online.has(user)) {
      this.#online.add(user);
      this.#emit(user, "online");
    }
  }

  /** Current presence of a user — `offline` for anyone who has never sent. */
  presence(user: string): Presence {
    const last = this.#lastActivity.get(user);
    return last !== undefined && this.#now() - last < this.#ttlMs ? "online" : "offline";
  }

  /** The users currently online, sorted (the agent-plane/panel view). */
  onlineUsers(): string[] {
    return [...this.#online].filter((user) => this.presence(user) === "online").sort();
  }

  /**
   * One fade-out pass (the `presenceSweepMs` cadence): every user whose window has
   * expired flips to `offline` and is reported once. Returns those names.
   */
  sweep(): string[] {
    const faded: string[] = [];
    for (const user of [...this.#online]) {
      if (this.presence(user) === "online") continue;
      this.#online.delete(user);
      faded.push(user);
      this.#emit(user, "offline");
    }
    return faded;
  }

  /** Sweep loop on the configured cadence; stops with the shutdown signal. */
  async run(signal: AbortSignal, intervalMs: number): Promise<void> {
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (signal.aborted) return;
      this.sweep();
    }
  }

  #emit(user: string, presence: Presence): void {
    try {
      this.#onChange?.(user, presence);
    } catch {
      // a broken listener must never break the router's hot path
    }
  }
}
