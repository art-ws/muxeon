// Token sampler (§12.8, FR-103): the background driver that turns the pure
// TokenUsageStore into a live, persisted series. Once per `sampleEvery` it captures
// an enabled agent's console pane, parses the token gauge (parseTokenCount) and
// records it; every `flushMs` (≤ 3 min, §12.8) it writes the dirty agents' minute
// and hour buckets to two JSON files each. Down agents are skipped (no pane). All
// side effects — capture, fs, clock — are injected so the core is unit-testable.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TokenTrackingConfig } from "@teamai/config";
import type { AgentStatus } from "@teamai/core";
import { parseRetainAge } from "@teamai/queue";
import {
  DEFAULT_MINUTE_SPAN_MS,
  type TokenBucketFile,
  type TokenUsageStore,
  parseTokenCount,
} from "./token-usage";

/** Sampler defaults (§12.8): 60s cadence, 60m minute depth, 1M-token ceiling. */
const DEFAULT_SAMPLE_EVERY_MS = 60_000;
const DEFAULT_MAX_THRESHOLD = 1_000_000;
/** Persist no more often than every 3 minutes (§12.8). */
const DEFAULT_FLUSH_MS = 180_000;
/** Base loop cadence — a sample fires within one tick of becoming due. */
const DEFAULT_TICK_MS = 5_000;

/** A type's `tokens` block resolved to numbers (durations → ms, defaults filled). */
export interface ResolvedTokenConfig {
  readonly sampleEveryMs: number;
  readonly minuteSpanMs: number;
  readonly maxThreshold: number;
}

/**
 * Resolve a per-type `tokens` block to numbers, or `undefined` when tracking is
 * off (no block, or `enabled: false`). Duration strings use the retain.age grammar.
 */
export function resolveTokenConfig(
  cfg: TokenTrackingConfig | undefined,
): ResolvedTokenConfig | undefined {
  if (cfg === undefined || cfg.enabled === false) return undefined;
  return {
    sampleEveryMs:
      cfg.sampleEvery !== undefined ? parseRetainAge(cfg.sampleEvery) : DEFAULT_SAMPLE_EVERY_MS,
    minuteSpanMs:
      cfg.minuteSpan !== undefined ? parseRetainAge(cfg.minuteSpan) : DEFAULT_MINUTE_SPAN_MS,
    maxThreshold: cfg.maxThreshold ?? DEFAULT_MAX_THRESHOLD,
  };
}

/** One agent the sampler should track: where to capture, and its resolved config. */
export interface SamplerAgentView {
  readonly name: string;
  readonly session: string;
  readonly config: ResolvedTokenConfig;
}

export interface TokenSamplerDeps {
  readonly store: TokenUsageStore;
  /** Enabled agents to sample — re-read each tick, so provisioning/teardown is picked up. */
  readonly agents: () => readonly SamplerAgentView[];
  /** Live status; the sampler skips `down`/unknown agents (no pane to read). */
  readonly status: (name: string) => AgentStatus | undefined;
  /** Capture an agent's console pane text (injected @teamai/tmux capturePane). */
  readonly capture: (session: string) => Promise<string>;
  /** Directory for `<session>.minutes.json` / `<session>.hours.json`. */
  readonly stateDir: string;
  readonly now?: () => number;
  readonly tickMs?: number;
  readonly flushMs?: number;
  readonly signal?: AbortSignal;
  /** Non-fatal capture/parse/fs errors surface here (default: swallow). */
  readonly onError?: (error: unknown, agent: string) => void;
}

export interface TokenSamplerHandle {
  /** Stop the loop and flush a final time. */
  readonly stop: () => Promise<void>;
  /** Capture + record every due agent once (also invoked by the loop). */
  readonly sampleOnce: (now: number) => Promise<void>;
  /** Persist every dirty agent's buckets to disk. */
  readonly flush: (now: number) => Promise<void>;
  /** Rehydrate all tracked agents from disk (called once at start). */
  readonly hydrate: (now: number) => Promise<void>;
}

const minuteFile = (dir: string, session: string): string => join(dir, `${session}.minutes.json`);
const hourFile = (dir: string, session: string): string => join(dir, `${session}.hours.json`);

async function writeJsonAtomic(path: string, body: TokenBucketFile): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(body));
  await rename(tmp, path);
}

async function readBucketFile(path: string): Promise<TokenBucketFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { buckets?: unknown }).buckets)
    ) {
      return parsed as TokenBucketFile;
    }
  } catch {
    // missing or malformed — a fresh series, not an error
  }
  return undefined;
}

export function startTokenSampler(deps: TokenSamplerDeps): TokenSamplerHandle {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
  const onError = deps.onError ?? (() => undefined);
  const abort = new AbortController();
  if (deps.signal !== undefined) {
    if (deps.signal.aborted) abort.abort();
    else deps.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  const lastSample = new Map<string, number>();
  let lastFlush = now();

  const sampleOnce = async (at: number): Promise<void> => {
    for (const view of deps.agents()) {
      const status = deps.status(view.name);
      if (status === undefined || status === "down") continue;
      const since = lastSample.get(view.name);
      if (since !== undefined && at - since < view.config.sampleEveryMs) continue;
      lastSample.set(view.name, at);
      try {
        const tokens = parseTokenCount(await deps.capture(view.session));
        if (tokens !== undefined)
          deps.store.record(view.name, tokens, at, view.config.minuteSpanMs);
      } catch (error) {
        onError(error, view.name);
      }
    }
  };

  const flush = async (at: number): Promise<void> => {
    const dir = deps.stateDir;
    let made = false;
    for (const agent of deps.store.agents()) {
      if (!deps.store.isDirty(agent)) continue;
      const view = deps.agents().find((v) => v.name === agent);
      const session = view?.session ?? agent;
      deps.store.series(agent, at); // force a prune before snapshot
      try {
        if (!made) {
          await mkdir(dir, { recursive: true });
          made = true;
        }
        await writeJsonAtomic(minuteFile(dir, session), deps.store.snapshot(agent, "minute"));
        await writeJsonAtomic(hourFile(dir, session), deps.store.snapshot(agent, "hour"));
        deps.store.clearDirty(agent);
      } catch (error) {
        onError(error, agent); // keep it dirty; retry next flush
      }
    }
    lastFlush = at;
  };

  const hydrate = async (at: number): Promise<void> => {
    for (const view of deps.agents()) {
      const minute = await readBucketFile(minuteFile(deps.stateDir, view.session));
      const hour = await readBucketFile(hourFile(deps.stateDir, view.session));
      deps.store.seed(view.name, "hour", hour, at, view.config.minuteSpanMs);
      deps.store.seed(view.name, "minute", minute, at, view.config.minuteSpanMs);
      deps.store.clearDirty(view.name); // seeded state is already on disk
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (abort.signal.aborted) return resolve();
      const timer = setTimeout(() => {
        abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });

  const loop = (async () => {
    await hydrate(now());
    while (!abort.signal.aborted) {
      const at = now();
      await sampleOnce(at);
      if (at - lastFlush >= flushMs) await flush(at);
      if (abort.signal.aborted) break;
      await sleep(tickMs);
    }
  })();

  return {
    stop: async () => {
      abort.abort();
      await loop.catch(() => undefined);
      await flush(now()).catch(() => undefined);
    },
    sampleOnce,
    flush,
    hydrate,
  };
}
