// Scheduler runtime (§6, §6.3): skip-missed priming + the periodic loop the server
// runs. Startup absorbs downtime, then ticks on a cadence and re-scans on a (longer)
// cadence to pick up file edits and the enabled:false kill-switch (FR-23).

import type { Routine } from "./discover";
import { type RescanOptions, rescan } from "./rescan";
import { type SchedulerDeps, tick } from "./scheduler";
import { cronFor } from "./time";

/**
 * Skip-missed (§6.3): if a cron was due during downtime, advance its lastRun to the
 * latest scheduled time ≤ now WITHOUT firing — missed ticks are not caught up
 * (catch-up is OOS-12); the next future tick runs normally. once and fresh cron are
 * left to the tick. Returns true if it absorbed missed ticks.
 */
export async function primeRoutine(routine: Routine, deps: SchedulerDeps): Promise<boolean> {
  if (!routine.enabled || routine.once) return false;
  const now = (deps.now ?? Date.now)();
  const existing = await deps.state.read(routine.owner, routine.id);
  if (existing?.lastRun === undefined) return false; // fresh → the tick anchors it (no backfill)
  const cron = cronFor(routine.schedule, routine.tz);
  const next = cron.nextRun(new Date(existing.lastRun));
  if (next === null || next.getTime() > now) return false; // nothing missed
  const [latest] = cron.previousRuns(1, new Date(now));
  if (latest === undefined) return false;
  await deps.state.write(routine.owner, routine.id, { lastRun: latest.getTime() });
  return true;
}

/** Prime every routine (skip-missed); returns how many absorbed missed ticks. */
export async function prime(routines: readonly Routine[], deps: SchedulerDeps): Promise<number> {
  let absorbed = 0;
  for (const routine of routines) if (await primeRoutine(routine, deps)) absorbed += 1;
  return absorbed;
}

export interface SchedulerRuntimeOptions extends SchedulerDeps {
  readonly routinesDir: string;
  readonly knownAgents: Iterable<string>;
  /** agent → cwd for the cwd-side discovery (FR-21b, §6.2); absent ⇒ central only. */
  readonly agentCwds?: ReadonlyMap<string, string>;
  /** Tick cadence (NFR-10); default 1000ms. */
  readonly tickIntervalMs?: number;
  /** Re-scan cadence — kill-switch / hot-add latency bound (§6); default 30000ms. */
  readonly rescanIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SchedulerHandle {
  stop(): Promise<void>;
}

/**
 * Start the scheduler loop: re-scan → skip-missed prime (once) → tick/poll, re-scanning
 * on its own cadence. Returns a handle whose stop() ends the loop. Priming runs only at
 * startup (absorbing downtime); a re-scan during uptime refreshes routines + prunes
 * orphans but does NOT re-prime (a due tick fires normally).
 */
export function startScheduler(options: SchedulerRuntimeOptions): SchedulerHandle {
  const tickMs = options.tickIntervalMs ?? 1000;
  const rescanMs = options.rescanIntervalMs ?? 30000;
  const now = options.now ?? Date.now;
  const rescanOpts: RescanOptions = {
    routinesDir: options.routinesDir,
    knownAgents: options.knownAgents,
    state: options.state,
    ...(options.agentCwds !== undefined ? { agentCwds: options.agentCwds } : {}),
  };
  const abort = new AbortController();
  // Default sleep is abortable, so stop() returns promptly instead of waiting out a tick.
  const sleep =
    options.sleep ??
    ((delay: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }));

  const refresh = async (): Promise<readonly Routine[]> => {
    const result = await rescan(rescanOpts);
    for (const s of result.skipped) options.log?.(`routine skipped: ${s.path}: ${s.reason}`);
    return result.routines;
  };

  const loop = (async () => {
    let routines = await refresh();
    await prime(routines, options); // skip-missed, once (§6.3)
    let lastRescan = now();
    while (!abort.signal.aborted) {
      await tick(routines, options);
      if (abort.signal.aborted) break;
      await sleep(tickMs);
      if (now() - lastRescan >= rescanMs) {
        routines = await refresh();
        lastRescan = now();
      }
    }
  })();

  return {
    stop: async () => {
      abort.abort();
      await loop.catch(() => undefined);
    },
  };
}
