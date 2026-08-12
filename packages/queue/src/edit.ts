// Queue edit primitives (§8.5): the raw FS moves behind operator-plane
// cancel/requeue. POLICY (done-window no-op, cur refusal) lives in the
// orchestrator's queue-admin; serialization lives in the session's control lane
// (§10.8) — these functions only move files.

import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { formatQueueName } from "@muxeon/core";
import { type QueuePaths, assertSafeFileId } from "./layout";

/** Remove one record from pending/ (cancel, §8.5). */
export async function removePending(paths: QueuePaths, filename: string): Promise<void> {
  await unlink(join(paths.pending, filename));
}

export interface RequeueStamp {
  readonly unixMs: number;
  readonly seq: number;
  /** Filesystem-safe id for the new filename (§8.7). */
  readonly fileId: string;
}

/**
 * Move one record from failed/ back to pending/ under a REGENERATED
 * `<unix_ms>-<seq>` name (it joins the FIFO tail, §5.3/§8.5) — a single atomic
 * rename, so the content (and with it the logical id, §10.9) is preserved and
 * there is no duplicate window. Returns the new pending filename.
 */
export async function requeueFailed(
  paths: QueuePaths,
  failedFilename: string,
  stamp: RequeueStamp,
): Promise<string> {
  assertSafeFileId(stamp.fileId);
  const next = formatQueueName({ unixMs: stamp.unixMs, seq: stamp.seq, id: stamp.fileId });
  await rename(join(paths.failed, failedFilename), join(paths.pending, next));
  return next;
}
