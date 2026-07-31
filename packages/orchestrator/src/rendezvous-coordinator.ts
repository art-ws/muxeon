// Rendezvous coordinator (§8.2, FR-105) — the impure driver around RendezvousStore.
// Direction S (operator decision): when A→B is refused WIP_LIMIT (FR-104), register an
// intent (A→B); when sender A is idle, notify the TARGET B ("A is free — send it your
// message") past B's WIP gate (bypassWip, kind:"rendezvous") and open a window for the
// counter-send B→A. The intent is dropped only on an accepted B→A (`onRouted`) or on
// reaching `maxAttempts`.
//
// The trigger is the SWEEP (cadence rendezvousSweepMs), not a busy→idle event: this
// dispatcher has no such event (afterTurn fires BEFORE the idle transition, §5.2), so
// the sweep is authoritative — it checks each sender's live status and only notifies
// an idle one. `onRefused` also kicks a fast-path tick (a no-op unless A is already
// idle). Notices carry a deterministic id (`rv:<A>:<B>:<attempt>`) so a duplicate
// (concurrent tick, redelivery) collapses in the done/ dedup window (§10.9).

import type { AgentStatus, Signal } from "@teamai/core";
import type { RendezvousStore } from "./rendezvous";
import type { RendezvousStateStore } from "./rendezvous-state";

/** Minimal route surface the coordinator needs (router.route with the bypass option). */
export type RendezvousRoute = (
  message: Signal,
  options?: { readonly bypassWip?: boolean },
) => Promise<{ readonly ok: boolean }>;

export interface RendezvousCoordinatorOptions {
  readonly store: RendezvousStore;
  readonly persist: RendezvousStateStore;
  readonly route: RendezvousRoute;
  /** Live status of a participant — undefined for a non-agent (operator/hub/unknown). */
  readonly statusOf: (name: string) => AgentStatus | undefined;
  /** Notify window in ms (resolved from `server.rendezvous.window`, FR-105). */
  readonly windowMs: number;
  /** Max notify rounds before an intent is dropped (FR-105). */
  readonly maxAttempts: number;
  /** Master switch (default true). */
  readonly enabled?: boolean;
  /** Clock; injectable for tests. Default Date.now. */
  readonly now?: () => number;
  /** Sweep cadence for `run()`; default 5000. */
  readonly sweepIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Warn sink for give-up / undeliverable notices; default process.stderr. */
  readonly log?: (message: string) => void;
}

/** The notice payload delivered to B: sender A is free, reach out to it (FR-105). */
export function rendezvousPayload(from: string, to: string): string {
  return [
    `Agent "${from}" tried to reach you ("${to}") earlier, but your queue was full (WIP limit, FR-104), so its message was refused.`,
    `"${from}" is now idle and available again.`,
    `If you still have something for "${from}", send it now: send(to="${from}", ...).`,
    "This is an automatic availability notice (FR-105) — you do not need to reply to this notice itself.",
  ].join(" ");
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RendezvousCoordinator {
  readonly #store: RendezvousStore;
  readonly #persist: RendezvousStateStore;
  readonly #route: RendezvousRoute;
  readonly #statusOf: (name: string) => AgentStatus | undefined;
  readonly #windowMs: number;
  readonly #maxAttempts: number;
  readonly #enabled: boolean;
  readonly #now: () => number;
  readonly #sweepIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (message: string) => void;
  // Per-sender tick lock — one tick per sender at a time (avoids a double-notify
  // race; the deterministic notice id is a second line of defense, §10.9).
  readonly #ticking = new Set<string>();

  constructor(options: RendezvousCoordinatorOptions) {
    this.#store = options.store;
    this.#persist = options.persist;
    this.#route = options.route;
    this.#statusOf = options.statusOf;
    this.#windowMs = options.windowMs;
    this.#maxAttempts = options.maxAttempts;
    this.#enabled = options.enabled ?? true;
    this.#now = options.now ?? Date.now;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? 5000;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#log =
      options.log ??
      ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
  }

  /**
   * Router `onRefused` hook: a WIP strike registers a reconnection intent (FR-105),
   * agent↔agent only (operators/hub retry themselves, and never register). Kicks a
   * fast-path tick — a no-op unless the sender is already idle.
   */
  onRefused(
    message: Signal,
    info: { readonly code: string; readonly limit?: number; readonly depth?: number },
  ): void {
    if (!this.#enabled || info.code !== "WIP_LIMIT") return;
    // A broadcast copy (§15.4, §10.16) is one-directional — a per-member WIP strike
    // must NOT register a reconnection intent (the whole point of a group/tag being an
    // input-only channel). The fan-out path already avoids firing onRefused for copies;
    // this guard makes the decoupling robust regardless of the caller.
    if (message.kind === "broadcast") return;
    const { from, to } = message;
    if (from === to) return;
    if (this.#statusOf(from) === undefined || this.#statusOf(to) === undefined) return;
    this.#store.register(from, to);
    void this.#flush(from);
    void this.#tick(from);
  }

  /**
   * Router `onRouted` hook: an accepted counter-send B→A (an ordinary message, not a
   * system kind) fulfils and removes the intent (A,B). B→A here is `from=B, to=A`, so
   * the intent to clear is keyed under the recipient A targeting the sender B.
   */
  onRouted(message: Signal): void {
    if (!this.#enabled) return;
    // System kinds never fulfil an intent. "broadcast" (§15.4, §10.16) is included:
    // the fan-out fires onRouted per member for transport visibility, but a broadcast
    // copy `from=S → to=M` is NOT a counter-send and must not resolve an intent (M,S).
    if (message.kind === "rendezvous" || message.kind === "nudge" || message.kind === "broadcast")
      return;
    if (this.#store.resolve(message.to, message.from)) void this.#flush(message.to);
  }

  /** Startup rehydrate — the FR-105 guarantee survives a server restart (§5.3/§10.9). */
  async rehydrate(): Promise<void> {
    for (const sender of await this.#persist.list()) {
      this.#store.seed(sender, (await this.#persist.read(sender)) ?? undefined);
    }
  }

  /** The safety-sweep loop (cadence rendezvousSweepMs) — the authoritative trigger. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sweep();
      // Abort races the sweep sleep (FR-49 spirit): shutdown must never sit out
      // a tick — the injected #sleep stays plain, tests drive sweep() directly.
      if (!signal.aborted) {
        await Promise.race([
          this.#sleep(this.#sweepIntervalMs),
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
      }
    }
  }

  /** One sweep pass over every sender with pending intents (visible for tests). */
  async sweep(): Promise<void> {
    for (const from of this.#store.senders()) await this.#tick(from);
  }

  /**
   * Panel view (FR-105): which agents are **waiting** (have ≥1 outgoing intent — the
   * "я жду" / ↑ marker) and which are **awaited** (are the target of some intent — the
   * "меня ждут" / ↓ marker). An agent can appear in both, one, or neither. Empty when
   * the coordinator is disabled or no intents are pending.
   */
  rendezvousState(): { readonly waiting: readonly string[]; readonly awaited: readonly string[] } {
    const waiting: string[] = [];
    const awaited = new Set<string>();
    for (const from of this.#store.senders()) {
      const intents = this.#store.intents(from);
      if (intents.length === 0) continue;
      waiting.push(from);
      for (const intent of intents) awaited.add(intent.to);
    }
    return { waiting, awaited: [...awaited] };
  }

  /**
   * Advance one sender: expire an elapsed window (rotate/drop), then notify the front
   * intent when the sender is idle and no window is open. Serialized per sender.
   */
  async #tick(from: string): Promise<void> {
    if (!this.#enabled || this.#ticking.has(from)) return;
    this.#ticking.add(from);
    try {
      const now = this.#now();
      // 1) an elapsed round: rotate to the back, or drop at maxAttempts.
      if (this.#store.windowExpired(from, now)) {
        const res = this.#store.expireFront(from, this.#maxAttempts);
        if (res?.outcome === "dropped") {
          this.#log(
            `teamai: rendezvous gave up on ${from}→${res.to} after ${this.#maxAttempts} attempts (FR-105)`,
          );
        }
      }
      // 2) still inside an open window → wait for the counter-send.
      if (this.#store.windowOpen(from, now)) return;
      // 3) notify the front intent, but only while the SENDER is idle (direction S).
      const front = this.#store.front(from);
      if (front !== undefined && front.phase === "waiting" && this.#statusOf(from) === "idle") {
        const to = front.to;
        const notice: Signal = {
          id: `rv:${from}:${to}:${front.attempts}`,
          from, // the A→B edge exists (it was the blocked edge, §10.2)
          to,
          kind: "rendezvous",
          ts: now,
          payload: rendezvousPayload(from, to),
        };
        const result = await this.#route(notice, { bypassWip: true });
        if (result.ok) {
          this.#store.markNotified(from, now + this.#windowMs);
        } else {
          // A rendezvous notice only fails on a permanent topology/unknown error →
          // the pair can never be reconnected; drop the intent rather than spin.
          this.#log(
            `teamai: rendezvous notice ${from}→${to} undeliverable — dropping intent (FR-105)`,
          );
          this.#store.resolve(from, to);
        }
      }
      await this.#flush(from);
    } finally {
      this.#ticking.delete(from);
    }
  }

  /** Persist a sender's queue if dirty: write the snapshot, or remove the file when empty. */
  async #flush(from: string): Promise<void> {
    if (!this.#store.isDirty(from)) return;
    try {
      if (this.#store.intents(from).length === 0) await this.#persist.remove(from);
      else await this.#persist.write(from, this.#store.snapshot(from));
      this.#store.clearDirty(from);
    } catch {
      // best-effort (§8.2) — a failed write is retried on the next mutation/sweep.
    }
  }
}
