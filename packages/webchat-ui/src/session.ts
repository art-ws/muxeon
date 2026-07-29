// Session auto-renewal policy (T125, FR-86) — the pure half, DOM-free for bun
// tests. The server says when the token dies (`expiresAt`, learned from
// GET /api/session); the panel renews at the HALF-LIFE of the remaining
// window: early enough that one missed tick (laptop lid, throttled background
// tab) still leaves half the window of slack, late enough not to spam the
// server. The timer half lives in App (useSessionRenewal).

/** When to fire the renewal (unix_ms): the half-life of the known window. */
export function renewDueAt(learnedAt: number, expiresAt: number): number {
  return learnedAt + Math.max(0, expiresAt - learnedAt) / 2;
}

/** The renewal check cadence — frequent enough for short test TTLs, cheap. */
export const SESSION_CHECK_MS = 60_000;
