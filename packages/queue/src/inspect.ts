// Read-only queue inspection (§8.5 peek, NFR-9): list a sub-state's records with
// their parsed bodies, ordered like dequeue (unix_ms → seq → id, §5.3). Non-queue
// files are skipped. Mutations stay with the single dispatcher (§10.8) — this
// module never moves anything.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type QueueName, type Signal, compareQueueNames, parseQueueName } from "@muxeon/core";
import type { QueuePaths } from "./layout";
import { readMessage } from "./record";

export type QueueSubState = "pending" | "cur" | "done" | "failed";

/**
 * WIP depth of a session (§8.2 backpressure, FR-104): the count of un-drained
 * queue records — everything in pending/ plus the single in-flight cur/ slot. It
 * is what the router compares against a recipient's WIP limit before admitting new
 * work; done/ and failed/ are terminal and never counted. Non-queue files are
 * ignored, and a missing sub-dir reads as empty (defense in depth — the server
 * ensures both at boot).
 */
export async function queueDepth(paths: QueuePaths): Promise<number> {
  const count = async (dir: string): Promise<number> => {
    const names = await readdir(dir).catch(() => [] as string[]);
    return names.filter((name) => name.endsWith(".json")).length;
  };
  const [pending, cur] = await Promise.all([count(paths.pending), count(paths.cur)]);
  return pending + cur;
}

export interface QueueEntry {
  readonly filename: string;
  readonly message: Signal;
}

/** Entries of one sub-state, oldest → newest. */
export async function listEntries(paths: QueuePaths, sub: QueueSubState): Promise<QueueEntry[]> {
  const dir = paths[sub];
  const named: { name: string; parsed: QueueName }[] = [];
  for (const name of await readdir(dir)) {
    try {
      named.push({ name, parsed: parseQueueName(name) });
    } catch {
      // not a queue record
    }
  }
  named.sort((a, b) => compareQueueNames(a.parsed, b.parsed));
  const entries: QueueEntry[] = [];
  for (const { name } of named) {
    try {
      entries.push({ filename: name, message: await readMessage(join(dir, name)) });
    } catch {
      // moved by the dispatcher between readdir and read (peek is a live snapshot)
    }
  }
  return entries;
}
