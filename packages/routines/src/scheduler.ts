// The single routine scheduler (§6). One evaluation per routine: decide if a tick is
// due, fire by sending a signal through the router (edge check §10.2 → enqueue), then
// advance the crash-safe state mark — strictly AFTER the enqueue (§6) so a crash in
// between replays the tick rather than losing it. The tick's signal id is DETERMINISTIC
// (`routine:<owner>:<id>:<once|scheduledISO>`), so a replayed tick is deduped (§10.9).
//
// `from` is always the owner agent (§6.2); `to` is the resolved target (self by
// default). A denied delivery (misconfigured cross-agent target) advances the state
// anyway and logs — it will not be fixed by retrying, and we avoid spamming.

import { type SignalRouter, sendSignal } from "@teamai/signals";
import type { Routine } from "./discover";
import type { StateStore } from "./state";
import { cronFor, wallTimeToInstant } from "./time";

export interface SchedulerDeps {
  readonly router: SignalRouter;
  readonly state: StateStore;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export type TickOutcome = "fired" | "not-due" | "done" | "disabled" | "primed" | "denied";

export interface TickResult {
  readonly owner: string;
  readonly id: string;
  readonly outcome: TickOutcome;
  /** The deterministic signal id, when a fire was attempted. */
  readonly signalId?: string;
}

async function fire(
  routine: Routine,
  signalId: string,
  now: number,
  deps: SchedulerDeps,
): Promise<boolean> {
  const result = await sendSignal(deps.router, {
    from: routine.owner, // owner-as-source (§6.2): from is always the owning agent
    to: routine.target,
    payload: routine.body,
    id: signalId, // deterministic → replay deduped (§10.9)
    ts: now,
    origin: `routine:${routine.id}`,
  });
  if (!result.ok) {
    deps.log?.(
      `routine ${routine.owner}/${routine.id}: delivery to "${routine.target}" ${result.code} — advancing state, not retrying`,
    );
    return false;
  }
  return true;
}

/** Evaluate one routine against `now`, firing and advancing state if a tick is due. */
export async function tickRoutine(routine: Routine, deps: SchedulerDeps): Promise<TickResult> {
  const now = (deps.now ?? Date.now)();
  const ref = { owner: routine.owner, id: routine.id };
  if (!routine.enabled) return { ...ref, outcome: "disabled" }; // kill-switch (§6.2/FR-23)

  const existing = await deps.state.read(routine.owner, routine.id);

  if (routine.once) {
    if (existing?.done === true) return { ...ref, outcome: "done" }; // already ran (§10.4)
    const due = routine.at === undefined || wallTimeToInstant(routine.at, routine.tz) <= now;
    if (!due) return { ...ref, outcome: "not-due" };
    const signalId = `routine:${routine.owner}:${routine.id}:once`;
    const fired = await fire(routine, signalId, now, deps);
    await deps.state.write(routine.owner, routine.id, { done: true, doneAt: now }); // after enqueue
    return { ...ref, outcome: fired ? "fired" : "denied", signalId };
  }

  // cron: a fresh routine anchors lastRun at discovery (now) and fires at the next
  // future tick — never backfilled (§6.3).
  if (existing?.lastRun === undefined) {
    await deps.state.write(routine.owner, routine.id, { lastRun: now });
    return { ...ref, outcome: "primed" };
  }
  const next = cronFor(routine.schedule, routine.tz).nextRun(new Date(existing.lastRun));
  if (next === null || next.getTime() > now) return { ...ref, outcome: "not-due" };
  const signalId = `routine:${routine.owner}:${routine.id}:${next.toISOString()}`;
  const fired = await fire(routine, signalId, now, deps);
  await deps.state.write(routine.owner, routine.id, { lastRun: next.getTime() }); // after enqueue
  return { ...ref, outcome: fired ? "fired" : "denied", signalId };
}

/** Evaluate every routine once; per-routine failures are isolated and logged. */
export async function tick(
  routines: readonly Routine[],
  deps: SchedulerDeps,
): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (const routine of routines) {
    try {
      results.push(await tickRoutine(routine, deps));
    } catch (error) {
      deps.log?.(`routine ${routine.owner}/${routine.id}: tick error: ${(error as Error).message}`);
    }
  }
  return results;
}
