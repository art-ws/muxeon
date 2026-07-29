// Orphan state pruning (§6.3). A state file with no matching routine in the current
// discovery (the routine was deleted or renamed) is orphaned: it is removed so that a
// later routine reusing the same id starts from a clean slate (no stale lastRun/done)
// — for once, that means it may run again as a new instance.

import type { Routine } from "./discover";
import type { RoutineRef, StateStore } from "./state";

const key = (owner: string, id: string): string => `${owner}\x00${id}`;

/** Remove state for every (owner,id) not present in `routines`. Returns what was pruned. */
export async function pruneOrphans(
  routines: readonly Routine[],
  store: StateStore,
): Promise<RoutineRef[]> {
  const live = new Set(routines.map((r) => key(r.owner, r.id)));
  const pruned: RoutineRef[] = [];
  for (const ref of await store.list()) {
    if (!live.has(key(ref.owner, ref.id))) {
      await store.remove(ref.owner, ref.id);
      pruned.push(ref);
    }
  }
  return pruned;
}
