// Retention sweep (§5.4, FR-34) — composed THROUGH orchestrator so @teamai/queue
// stays orchestrator-only (§8). One sweep: per session, prune done/ (double cap)
// and failed/ (independent), shrink the live dedup window by the pruned done/ ids
// (§10.9), then run blob GC over the surviving records (§5.4: GC is tied to the
// prune, never a free-standing scan). The cadence default is T41-calibrated
// (NFR-10, T41-calibrated).

import {
  type QueuePaths,
  type RetentionPolicy,
  gcBlobs,
  pruneArchive,
  queuePaths,
} from "@teamai/queue";

export type { RetentionPolicy } from "@teamai/queue";
export { parseRetainAge } from "@teamai/queue";

export interface RetentionTarget {
  /** Queue key — the agent's tmux name or the operator name (§5.3). */
  readonly session: string;
  readonly policy: RetentionPolicy;
  /** Shrinks the owner's live dedup window after done/ pruning (§10.9). */
  readonly forgetDone: (ids: Iterable<string>) => void;
  /**
   * Queue-root override: federation link queues live under `<root>/fed/`
   * (§18.5) but prune exactly like every other maildir. Targets with an
   * override are excluded from blob GC (blob refs never federate).
   */
  readonly root?: string;
}

export interface RetentionOptions {
  /** Queue root <root> (§5.3). */
  readonly root: string;
  readonly targets: readonly RetentionTarget[];
  /** Blob GC age floor (§5.4) — the server-level retain.age. */
  readonly blobAgeMs: number;
  /** Extra per-sweep pruners outside the queues (webchat history, §12.3). */
  readonly extraSweeps?: readonly (() => Promise<void>)[];
  /** Extra blob-reference files outside the queues (webchat history, §12.3). */
  readonly extraRefFiles?: () => Promise<readonly string[]>;
  /** Sweep cadence; default 60s (NFR-10, T41-calibrated). */
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RetentionHandle {
  /** One full sweep: prune every target, then blob GC. */
  sweep(): Promise<void>;
  /** Periodic loop until aborted. */
  run(signal: AbortSignal): Promise<void>;
}

// Abort-aware sleep so stop() returns promptly instead of waiting out a sweep tick.
const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function createRetention(options: RetentionOptions): RetentionHandle {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 60_000;
  const pathsOf = new Map<RetentionTarget, QueuePaths>(
    options.targets.map((target) => [
      target,
      queuePaths(target.root ?? options.root, target.session),
    ]),
  );

  const sweep = async (): Promise<void> => {
    const at = now();
    for (const target of options.targets) {
      const paths = pathsOf.get(target);
      if (paths === undefined) continue;
      const pruned = await pruneArchive(paths, "done", target.policy, at);
      target.forgetDone(pruned); // §10.9: the window IS the current done/
      await pruneArchive(paths, "failed", target.policy, at); // independent (§5.4)
    }
    for (const extra of options.extraSweeps ?? []) await extra(); // §12.3: prune BEFORE GC
    await gcBlobs({
      root: options.root,
      // Only the queues under the shared root reference blobs (§5.3); an
      // overridden-root target (a link queue) holds no local blob refs (§18.5).
      sessions: options.targets
        .filter((target) => target.root === undefined)
        .map((target) => target.session),
      ageMs: options.blobAgeMs,
      ...(options.extraRefFiles !== undefined ? { extraRefFiles: options.extraRefFiles } : {}),
      now,
    });
  };

  return {
    sweep,
    run: async (signal) => {
      const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, signal));
      while (!signal.aborted) {
        await sleep(intervalMs);
        if (signal.aborted) break;
        await sweep();
      }
    },
  };
}
