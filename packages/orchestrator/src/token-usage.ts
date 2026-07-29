// Token accounting (§12.8, FR-103): a per-agent time series of the token gauge
// read off the agent's console. Two resolutions on one 24h window — per-minute
// detail for the recent `minuteSpan`, per-hour maxima behind it. Both buckets keep
// the MAXIMUM gauge seen in the slot (§12.8: "anything older keeps only the hour's
// maximum") — this is a level (context fill), not a summed rate, so max is the
// faithful aggregate. This module is PURE (no fs, no tmux); the sampler (token-
// sampler.ts) drives it and persists snapshots.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Fixed retention of the whole series (§12.8): the last 24h, both resolutions. */
export const TOKEN_RETENTION_MS = 24 * HOUR_MS;
/** Default per-minute depth when a type omits `tokens.minuteSpan`. */
export const DEFAULT_MINUTE_SPAN_MS = 60 * MINUTE_MS;

/** One histogram column: `t` = bucket start (unix ms), `tokens` = the slot maximum. */
export interface TokenBucket {
  readonly t: number;
  readonly tokens: number;
}

/** What the panel draws: hourly zone (older) + minute zone (recent) + the live gauge. */
export interface TokenSeries {
  /** Per-minute columns within `minuteSpan`, ascending by time. */
  readonly minutes: readonly TokenBucket[];
  /** Per-hour columns older than `minuteSpan` (down to 24h), ascending by time. */
  readonly hours: readonly TokenBucket[];
  /** Latest sampled gauge (0 when nothing sampled yet). */
  readonly current: number;
  /** Unix ms of the latest sample (0 when none). */
  readonly updatedAt: number;
}

/** Serialisable form of one resolution — what a JSON state file holds. */
export interface TokenBucketFile {
  readonly version: 1;
  readonly buckets: readonly (readonly [number, number])[];
}

interface AgentState {
  readonly minute: Map<number, number>;
  readonly hour: Map<number, number>;
  minuteSpanMs: number;
  current: number;
  updatedAt: number;
  dirty: boolean;
}

/**
 * The bottom-most context-size gauge on a captured console pane, or `undefined`
 * when none is present. Two console dialects are recognized (FR-103, §12.8):
 *
 *  - **Claude Code** — `<n> tokens`: a plain integer (optionally with thousands
 *    separators) immediately before the word "tokens". The streaming
 *    `↓ 7.1k tokens` form is intentionally ignored (fractional / k-suffixed → not
 *    the context gauge).
 *  - **Codex** — `<n>[.d][K|M] used`: e.g. `23.4K used`, `166K used`, `138K used`
 *    on the status line `gpt-5.6-sol xhigh · <cwd> · <n>K used`. A `K`/`M` suffix
 *    scales the (possibly fractional) number by 1e3 / 1e6; no suffix is a plain
 *    count. Here the k-suffix IS the gauge (Codex reports context in thousands) —
 *    the opposite of the Claude streaming form; the distinct "used" keyword keeps
 *    the dialects from colliding.
 *
 * A pane shows only one dialect, so both are scanned and the bottom-most match
 * (the live input-box gauge) wins — for Codex that is the status line at the very
 * bottom of the pane.
 */
export function parseTokenCount(pane: string): number | undefined {
  const re = /(\d[\d,\u00a0\u202f ]*)\s*tokens\b|(\d+(?:\.\d+)?)\s*([km])?\s*used\b/gi;
  let last: number | undefined;
  for (let m = re.exec(pane); m !== null; m = re.exec(pane)) {
    if (m[1] !== undefined) {
      // Claude `<n> tokens` — strip thousands separators, read the integer.
      const digits = m[1].replace(/[^\d]/g, "");
      if (digits.length === 0) continue;
      const value = Number(digits);
      if (Number.isFinite(value)) last = value;
    } else if (m[2] !== undefined) {
      // Codex `<n>[K|M] used` — scale by the suffix, round to whole tokens.
      const value = Number(m[2]);
      if (!Number.isFinite(value)) continue;
      const suffix = (m[3] ?? "").toLowerCase();
      const scale = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
      last = Math.round(value * scale);
    }
  }
  return last;
}

const bucketStart = (now: number, span: number): number => Math.floor(now / span) * span;

function pruneState(state: AgentState, now: number): void {
  const minuteFloor = now - state.minuteSpanMs;
  for (const t of state.minute.keys()) if (t < minuteFloor) state.minute.delete(t);
  const hourFloor = now - TOKEN_RETENTION_MS;
  for (const t of state.hour.keys()) if (t < hourFloor) state.hour.delete(t);
}

/**
 * In-memory per-agent token series with max-aggregated minute and hour buckets.
 * One instance owned by the sampler; the server queries `series()` per request.
 */
export class TokenUsageStore {
  readonly #agents = new Map<string, AgentState>();

  #state(agent: string, minuteSpanMs?: number): AgentState {
    let state = this.#agents.get(agent);
    if (state === undefined) {
      state = {
        minute: new Map(),
        hour: new Map(),
        minuteSpanMs: minuteSpanMs ?? DEFAULT_MINUTE_SPAN_MS,
        current: 0,
        updatedAt: 0,
        dirty: false,
      };
      this.#agents.set(agent, state);
    } else if (minuteSpanMs !== undefined) {
      state.minuteSpanMs = minuteSpanMs;
    }
    return state;
  }

  /** Record one gauge sample; folds it into the minute and hour maxima, then prunes. */
  record(agent: string, tokens: number, now: number, minuteSpanMs?: number): void {
    const state = this.#state(agent, minuteSpanMs);
    const mKey = bucketStart(now, MINUTE_MS);
    const hKey = bucketStart(now, HOUR_MS);
    state.minute.set(mKey, Math.max(state.minute.get(mKey) ?? 0, tokens));
    state.hour.set(hKey, Math.max(state.hour.get(hKey) ?? 0, tokens));
    state.current = tokens;
    state.updatedAt = now;
    state.dirty = true;
    pruneState(state, now);
  }

  /** The two-zone series for the panel: recent minutes + older hours + live gauge. */
  series(agent: string, now: number): TokenSeries {
    const state = this.#agents.get(agent);
    if (state === undefined) return { minutes: [], hours: [], current: 0, updatedAt: 0 };
    pruneState(state, now);
    const windowStart = now - state.minuteSpanMs;
    const hourCut = bucketStart(windowStart, HOUR_MS); // hours strictly before this are "old"
    const minutes = [...state.minute.entries()]
      .filter(([t]) => t >= windowStart)
      .sort((a, b) => a[0] - b[0])
      .map(([t, tokens]) => ({ t, tokens }));
    const hours = [...state.hour.entries()]
      .filter(([t]) => t < hourCut)
      .sort((a, b) => a[0] - b[0])
      .map(([t, tokens]) => ({ t, tokens }));
    return { minutes, hours, current: state.current, updatedAt: state.updatedAt };
  }

  /** True when the agent has unpersisted samples since the last `clearDirty`. */
  isDirty(agent: string): boolean {
    return this.#agents.get(agent)?.dirty ?? false;
  }

  clearDirty(agent: string): void {
    const state = this.#agents.get(agent);
    if (state !== undefined) state.dirty = false;
  }

  /** Every agent that has any recorded state (for a persistence sweep). */
  agents(): readonly string[] {
    return [...this.#agents.keys()];
  }

  /** Snapshot one resolution as a serialisable file body (ascending, pruned by caller). */
  snapshot(agent: string, resolution: "minute" | "hour"): TokenBucketFile {
    const state = this.#agents.get(agent);
    const map = state === undefined ? new Map<number, number>() : state[resolution];
    const buckets = [...map.entries()].sort((a, b) => a[0] - b[0]);
    return { version: 1, buckets };
  }

  /**
   * Seed a resolution from a loaded file (startup rehydrate). Buckets older than
   * their retention are dropped against `now`; `current`/`updatedAt` track the
   * newest bucket so the health orb survives a restart.
   */
  seed(
    agent: string,
    resolution: "minute" | "hour",
    file: TokenBucketFile | undefined,
    now: number,
    minuteSpanMs?: number,
  ): void {
    const state = this.#state(agent, minuteSpanMs);
    if (file === undefined) return;
    const floor = resolution === "minute" ? now - state.minuteSpanMs : now - TOKEN_RETENTION_MS;
    for (const [t, tokens] of file.buckets) {
      if (typeof t !== "number" || typeof tokens !== "number" || t < floor) continue;
      const map = state[resolution];
      map.set(t, Math.max(map.get(t) ?? 0, tokens));
      if (t + (resolution === "minute" ? MINUTE_MS : HOUR_MS) > state.updatedAt) {
        state.updatedAt = Math.max(state.updatedAt, t);
        state.current = tokens;
      }
    }
  }
}
