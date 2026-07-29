// Periodic re-scan (§6). Re-discovers routines (central + cwd-side merge, §6.2)
// and prunes orphan state. The scheduler runtime calls this on a cadence so that
// file edits take effect within one interval: a freshly added `schedule: once` is
// picked up, and the `enabled: false` kill-switch (FR-23) stops a routine —
// because the next tick reads the refreshed enabled flag. Re-scan does NOT
// advance schedules or fire (that is the tick); it only refreshes the routine set
// and reconciles state.

import {
  type MergedDiscoverOptions,
  type Routine,
  type SkippedRoutine,
  discoverRoutines,
} from "./discover";
import { pruneOrphans } from "./orphan";
import type { RoutineRef, StateStore } from "./state";

export interface RescanOptions extends MergedDiscoverOptions {
  readonly state: StateStore;
}

export interface RescanResult {
  readonly routines: Routine[];
  readonly skipped: SkippedRoutine[];
  readonly pruned: RoutineRef[];
}

export async function rescan(options: RescanOptions): Promise<RescanResult> {
  const { routines, skipped } = discoverRoutines(options); // central + cwd (§6.2)
  const pruned = await pruneOrphans(routines, options.state);
  return { routines, skipped, pruned };
}
