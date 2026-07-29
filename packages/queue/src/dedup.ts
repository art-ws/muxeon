// Dedup window (§10.9): the set of logical ids already processed is exactly the
// current contents of done/. The single dispatcher loads this once at startup and
// maintains it incrementally as turns complete, then passes it to dequeue so a
// re-enqueued duplicate is dropped. Pruning done/ (§5.4) narrows the window.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Signal } from "@teamai/core";
import type { QueuePaths } from "./layout";
import { readMessage } from "./record";

export async function loadDoneIds(paths: QueuePaths): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of await readdir(paths.done)) {
    if (!name.endsWith(".json")) continue;
    let message: Signal;
    try {
      message = await readMessage(join(paths.done, name));
    } catch {
      continue; // skip an unreadable archive entry
    }
    ids.add(message.id);
  }
  return ids;
}
