// Complete (§5.3, FR-35b): atomically move the in-flight cur/ file to done/ or
// failed/. `done` means "turn complete" (NOT semantic success — busy→idle only
// detects turn completion, §5.2). `failed` means a render/inject error
// (adapters.render threw, or tmux injection failed on a live session). A busy→down
// loss is NOT a completion — it is re-sent from cur/ (recovery), never moved here.

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { QueuePaths } from "./layout";

export type CompleteOutcome = "done" | "failed";

export async function complete(
  paths: QueuePaths,
  filename: string,
  outcome: CompleteOutcome,
): Promise<void> {
  const source = join(paths.cur, filename);
  const target = join(outcome === "done" ? paths.done : paths.failed, filename);
  try {
    await rename(source, target);
  } catch (error) {
    // Idempotent completion: a redelivery/recovery race can move (or re-complete)
    // the same cur/ file, so the source may already be gone. An ENOENT here means
    // the turn is ALREADY completed — treat it as a no-op rather than crashing the
    // single dispatcher with an unhandled rejection (observed: a cur→done ENOENT
    // storm survived only because Bun tolerated it; §10.8/§5.3).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
