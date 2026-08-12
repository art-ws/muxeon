// Operator queue-edit operations (§8.5, NFR-9), exposed THROUGH orchestrator so
// @muxeon/queue stays orchestrator-only (§8). peek is read-only and safe outside
// the loop; cancel/requeue are MUTATIONS — the caller (server admin) must run them
// via the session's ControlLane so the single owner of pending/cur is preserved
// (§10.8) and there is no TOCTOU with dequeue.

import {
  type QueueEntry,
  type QueuePaths,
  listEntries,
  readCur,
  removePending,
  requeueFailed,
  sanitizeFileId,
} from "@muxeon/queue";
import type { QueueStamp } from "./router";

export type { QueueEntry } from "@muxeon/queue";

export interface PeekResult {
  readonly pending: QueueEntry[];
  readonly cur: QueueEntry[];
}

/** Inspect a session's pending/ and cur/ (§8.5 peek; maildir stays observable, NFR-9). */
export async function peekQueue(paths: QueuePaths): Promise<PeekResult> {
  return {
    pending: await listEntries(paths, "pending"),
    cur: await listEntries(paths, "cur"),
  };
}

export type CancelOutcome = "cancelled" | "in-flight" | "not-found";

/**
 * Cancel a pending record by its LOGICAL id (§8.5). An id already claimed into
 * cur/ is refused ("in-flight") — the turn owns it. Run via the ControlLane.
 */
export async function cancelPendingById(paths: QueuePaths, id: string): Promise<CancelOutcome> {
  const inFlight = await readCur(paths);
  if (inFlight !== null && inFlight.message.id === id) return "in-flight";
  for (const entry of await listEntries(paths, "pending")) {
    if (entry.message.id === id) {
      await removePending(paths, entry.filename);
      return "cancelled";
    }
  }
  return "not-found";
}

export type RequeueResult =
  | { readonly outcome: "requeued"; readonly filename: string }
  | { readonly outcome: "already-done" }
  | { readonly outcome: "not-found" };

/**
 * Requeue a failed record by its LOGICAL id (§8.5): a fresh `<unix_ms>-<seq>` name
 * (FIFO tail) with the same content/id (dedup keeps working, §10.9). An id already
 * in the done/ window → explicit no-op. Run via the ControlLane.
 */
export async function requeueFailedById(
  paths: QueuePaths,
  id: string,
  stamp: QueueStamp,
  doneIds: ReadonlySet<string>,
): Promise<RequeueResult> {
  if (doneIds.has(id)) return { outcome: "already-done" };
  for (const entry of await listEntries(paths, "failed")) {
    if (entry.message.id === id) {
      const filename = await requeueFailed(paths, entry.filename, {
        ...stamp,
        fileId: sanitizeFileId(id),
      });
      return { outcome: "requeued", filename };
    }
  }
  return { outcome: "not-found" };
}
