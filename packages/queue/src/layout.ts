// Maildir-style queue layout (§5.3). Each session owns a directory with five
// sub-states; transitions between them are atomic rename(2). The whole session
// layout and <root>/blobs/ must live on ONE filesystem so every rename is atomic.
// `queue` is a dumb FS layer — it performs no topology checks (that is the router,
// §8.2). It does enforce the §8.7 input boundary: file-id and session-name safety.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_FILE_ID = 200;
const SAFE_FILE_ID = /^[A-Za-z0-9_-]+$/;

export const QUEUE_SUBDIRS = ["tmp", "pending", "cur", "done", "failed"] as const;

export interface QueuePaths {
  readonly root: string;
  readonly session: string;
  readonly dir: string; // <root>/<session>
  readonly tmp: string; // write-in-progress, then atomic rename into pending/
  readonly pending: string; // queued messages (FIFO by name, §5.3)
  readonly cur: string; // the single in-flight message; |cur| ≤ 1 (§10.1/§10.8)
  readonly done: string; // archived (turn complete)
  readonly failed: string; // render/inject error (§5.3, FR-35b)
}

// A session name keys a directory under <root>; reject anything that is not a
// single safe path segment (defense in depth — names come from validated config).
export function assertSafeSessionName(session: string): void {
  if (
    session.length === 0 ||
    session === "." ||
    session === ".." ||
    session.includes("/") ||
    session.includes("\\") ||
    session.includes("\0")
  ) {
    throw new Error(`unsafe queue session name: ${JSON.stringify(session)}`);
  }
}

export function queuePaths(root: string, session: string): QueuePaths {
  assertSafeSessionName(session);
  const dir = join(root, session);
  return {
    root,
    session,
    dir,
    tmp: join(dir, "tmp"),
    pending: join(dir, "pending"),
    cur: join(dir, "cur"),
    done: join(dir, "done"),
    failed: join(dir, "failed"),
  };
}

export async function ensureQueueDirs(paths: QueuePaths): Promise<void> {
  await Promise.all(QUEUE_SUBDIRS.map((sub) => mkdir(join(paths.dir, sub), { recursive: true })));
}

// --- file-id safety (§8.7) --------------------------------------------------

/** Whether `id` is a safe filename component: §8.7 charset and bounded length. */
export function isSafeFileId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_FILE_ID && SAFE_FILE_ID.test(id);
}

export function assertSafeFileId(id: string): void {
  if (!isSafeFileId(id)) throw new Error(`unsafe queue file id: ${JSON.stringify(id)}`);
}

/**
 * Derives a filesystem-safe filename id from an untrusted logical id (§8.7): keeps
 * [A-Za-z0-9_-], replaces every other character with "_", caps the length, and
 * never returns empty. Lossy by design — the logical id is preserved in the
 * message body, and filename uniqueness comes from the <unix_ms>-<seq> prefix.
 */
export function sanitizeFileId(logicalId: string): string {
  const cleaned = logicalId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_FILE_ID);
  return cleaned.length > 0 ? cleaned : "_";
}
