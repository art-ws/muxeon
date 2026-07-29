// Recovery (§5.3, §10.9): the message left in cur/ is an unfinished turn (a crash
// between claim and complete). After restart the dispatcher reads it and re-sends
// it IN PLACE — the slot and FIFO position are preserved, so delivery is
// at-least-once. This is read-only; the file stays in cur/ until the re-sent turn
// completes.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DequeuedItem } from "./dequeue";
import type { QueuePaths } from "./layout";
import { readMessage } from "./record";

/** The in-flight message in cur/, or null if nothing is in flight. */
export async function readCur(paths: QueuePaths): Promise<DequeuedItem | null> {
  const filename = (await readdir(paths.cur)).find((name) => name.endsWith(".json"));
  if (filename === undefined) return null;
  const path = join(paths.cur, filename);
  return { filename, path, message: await readMessage(path) };
}
