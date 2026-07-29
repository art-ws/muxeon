// Dequeue (§5.3, FR-13) — the atomic claim primitive for the SINGLE dispatcher per
// session (§10.8). If cur/ is non-empty the session is busy and nothing new is
// claimed (§10.1); otherwise the oldest pending file is atomically renamed into the
// single cur/ slot. Dedup (§10.9) drops a candidate whose LOGICAL id (from the body,
// not the lossy filename id) is already in done/ — the caller supplies that id set.

import { readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type QueueName, type Signal, compareQueueNames, parseQueueName } from "@teamai/core";
import type { QueuePaths } from "./layout";
import { readMessage } from "./record";

export interface DequeuedItem {
  readonly filename: string;
  readonly path: string; // path within cur/
  readonly message: Signal;
}

export interface DequeueOptions {
  /** Logical ids already in done/ (the dedup window, §10.9); duplicates are dropped. */
  readonly skipIds?: ReadonlySet<string>;
}

const NO_SKIP: ReadonlySet<string> = new Set();

export async function dequeue(
  paths: QueuePaths,
  options: DequeueOptions = {},
): Promise<DequeuedItem | null> {
  if (await curIsNonEmpty(paths)) return null; // §10.1/§10.8: busy — claim nothing new
  const skipIds = options.skipIds ?? NO_SKIP;
  for (const filename of await listPendingOrdered(paths)) {
    const pendingPath = join(paths.pending, filename);
    const message = await readMessage(pendingPath);
    if (skipIds.has(message.id)) {
      await unlink(pendingPath); // already processed (§10.9) — drop the duplicate
      continue;
    }
    const curPath = join(paths.cur, filename);
    await rename(pendingPath, curPath); // atomic claim into the single slot
    return { filename, path: curPath, message };
  }
  return null;
}

async function curIsNonEmpty(paths: QueuePaths): Promise<boolean> {
  return (await readdir(paths.cur)).some((name) => name.endsWith(".json"));
}

/** Pending filenames ordered oldest → newest (unix_ms → seq → id; §5.3). */
export async function listPendingOrdered(paths: QueuePaths): Promise<string[]> {
  const items: { name: string; parsed: QueueName }[] = [];
  for (const name of await readdir(paths.pending)) {
    let parsed: QueueName;
    try {
      parsed = parseQueueName(name);
    } catch {
      continue; // skip anything that is not a queue file
    }
    items.push({ name, parsed });
  }
  items.sort((a, b) => compareQueueNames(a.parsed, b.parsed));
  return items.map((item) => item.name);
}
