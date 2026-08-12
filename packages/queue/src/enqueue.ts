// Enqueue (§5.3, FR-12/14/15): write the message JSON to tmp/, then atomically
// rename it into pending/. The rename is atomic, so any number of concurrent
// producers (channels, signals, routines, other agents — all via the router,
// §8.2) are safe; nothing is lost or torn. The filename carries the SANITIZED id
// (§8.7); the logical id (idempotency key, §10.9) lives in the body.

import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Signal, formatQueueName } from "@muxeon/core";
import { type QueuePaths, assertSafeFileId } from "./layout";

export interface EnqueueRecord {
  readonly unixMs: number;
  readonly seq: number;
  /** Filesystem-safe id for the filename (§8.7); see sanitizeFileId. */
  readonly fileId: string;
  /** The message, stored verbatim as JSON; carries the logical id. */
  readonly message: Signal;
}

/** Atomically enqueues `record` into pending/ and returns the queue filename. */
export async function enqueue(paths: QueuePaths, record: EnqueueRecord): Promise<string> {
  assertSafeFileId(record.fileId); // §8.7: no path separators escape pending/
  const filename = formatQueueName({ unixMs: record.unixMs, seq: record.seq, id: record.fileId });
  const tmpPath = join(paths.tmp, filename);
  const pendingPath = join(paths.pending, filename);
  await writeFile(tmpPath, JSON.stringify(record.message), { encoding: "utf8" });
  await rename(tmpPath, pendingPath); // atomic move into pending/
  return filename;
}
