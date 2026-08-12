// Retention / pruning (§5.4, FR-34). done/ and failed/ grow without bound unless
// capped: a record older than retain.age OR beyond retain.count (oldest first) is
// removed. failed/ is pruned independently (a diagnostic archive — it never feeds
// dedup). Pruning done/ NARROWS the dedup window (§10.9): the pruned records'
// LOGICAL ids are returned so the owner can shrink its live id set accordingly.
// Numeric defaults are T41-calibrated (NFR-10, see SPEC.md §7.1).

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseQueueName } from "@muxeon/core";
import { listEntries } from "./inspect";
import type { QueuePaths } from "./layout";

export interface RetentionPolicy {
  /** Age cap, milliseconds: records with an older filename unix_ms are pruned. */
  readonly ageMs: number;
  /** Count cap: only the newest `count` records survive. */
  readonly count: number;
}

const AGE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parse a retain.age string (§7.1): "7d", "12h", "30m", "45s", "500ms". */
export function parseRetainAge(text: string): number {
  const match = AGE.exec(text.trim());
  if (match === null) {
    throw new Error(`invalid retain.age "${text}" (expected <n>ms|s|m|h|d, e.g. "7d")`);
  }
  const [, amount = "0", unit = "ms"] = match;
  return Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
}

/**
 * Apply the double cap to one archive sub-state (§5.4): prune everything older
 * than `ageMs` and everything beyond the newest `count`. Returns the LOGICAL ids
 * of the pruned records (for the §10.9 window shrink on done/).
 */
export async function pruneArchive(
  paths: QueuePaths,
  sub: "done" | "failed",
  policy: RetentionPolicy,
  now: number,
): Promise<string[]> {
  const entries = await listEntries(paths, sub); // oldest → newest (§5.3 order)
  const cutoff = now - policy.ageMs;
  const overCount = Math.max(0, entries.length - policy.count);
  const removed: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const tooOld = parseQueueName(entry.filename).unixMs < cutoff;
    if (!tooOld && index >= overCount) continue; // young and within the count cap
    try {
      await unlink(join(paths[sub], entry.filename));
      removed.push(entry.message.id);
    } catch {
      // already gone — racing a concurrent sweep is harmless
    }
  }
  return removed;
}
