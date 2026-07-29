// Blob garbage collection (§5.4). A blob is collected only when (a) NO record in
// any session's pending/cur/done/failed references it and (b) it is older than
// retain.age — the age floor closes the "blob written, referencing record not yet
// enqueued" gap (§5.4 write order: blob first, then the record). Reference
// detection is conservative: a blob id appearing anywhere in a record's raw JSON
// counts as a reference (ids are opaque UUIDs, §5.3 — no payload-shape knowledge
// needed; a false positive merely retains a blob). GC runs as part of the
// retention sweep, after pruning — never as a free-standing scan.

import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { blobsDir } from "./blobs";
import { QUEUE_SUBDIRS, queuePaths } from "./layout";

export interface BlobGcOptions {
  /** Queue root <root> (§5.3); blobs live under <root>/blobs/. */
  readonly root: string;
  /** Every session/pseudo-session queue key — all reference sources. */
  readonly sessions: readonly string[];
  /** Age floor, milliseconds (retain.age, §5.4). */
  readonly ageMs: number;
  /**
   * Extra reference-source files OUTSIDE the queues (absolute paths) — e.g. the
   * webchat history logs (§12.3): a blob alive in a chat outlives its pruned
   * queue record. Scanned with the same conservative text match.
   */
  readonly extraRefFiles?: () => Promise<readonly string[]>;
  readonly now?: () => number;
}

const RECORD_SUBDIRS = QUEUE_SUBDIRS.filter((sub) => sub !== "tmp");

/** Collect unreferenced, old-enough blobs; returns the removed blob ids. */
export async function gcBlobs(options: BlobGcOptions): Promise<string[]> {
  const now = (options.now ?? Date.now)();
  const dir = blobsDir(options.root);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no blob store yet
  }
  const candidates: string[] = [];
  for (const name of names) {
    if (name === "tmp") continue; // the write staging dir, never a blob
    try {
      const info = await stat(join(dir, name));
      if (info.isFile() && now - info.mtimeMs > options.ageMs) candidates.push(name);
    } catch {
      // vanished mid-scan
    }
  }
  if (candidates.length === 0) return [];

  const referenced = new Set<string>();
  for (const session of options.sessions) {
    const paths = queuePaths(options.root, session);
    for (const sub of RECORD_SUBDIRS) {
      let records: string[];
      try {
        records = await readdir(paths[sub]);
      } catch {
        continue;
      }
      for (const record of records) {
        if (!record.endsWith(".json")) continue;
        let text: string;
        try {
          text = await readFile(join(paths[sub], record), "utf8");
        } catch {
          continue; // moved mid-scan
        }
        for (const id of candidates) if (text.includes(id)) referenced.add(id);
      }
    }
  }

  for (const file of (await options.extraRefFiles?.()) ?? []) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // pruned mid-scan
    }
    for (const id of candidates) if (text.includes(id)) referenced.add(id);
  }

  const removed: string[] = [];
  for (const id of candidates) {
    if (referenced.has(id)) continue;
    try {
      await unlink(join(dir, id));
      removed.push(id);
    } catch {
      // already gone
    }
  }
  return removed;
}
