// Session runtime helpers (§8.2) — the queue and tmux primitives the composition
// root (server) needs, exposed THROUGH orchestrator so @muxeon/queue stays
// orchestrator-only (§8) and the server never imports queue or tmux directly.

import { type QueuePaths, ensureQueueDirs, loadDoneIds, queuePaths, readCur } from "@muxeon/queue";
import { hasSession } from "@muxeon/tmux";

export type { QueuePaths } from "@muxeon/queue";

export function sessionPaths(root: string, key: string): QueuePaths {
  return queuePaths(root, key);
}

/** Create a participant's queue directories (so routing accumulates even when down). */
export async function ensureSessionQueue(root: string, key: string): Promise<void> {
  await ensureQueueDirs(queuePaths(root, key));
}

/** Load a session's dedup window (done/ logical ids) for the dispatcher (§10.9). */
export async function loadSessionDoneIds(root: string, key: string): Promise<Set<string>> {
  return loadDoneIds(queuePaths(root, key));
}

/** Attach probe: whether the agent's tmux session is live (§5.1). */
export async function probeSession(name: string): Promise<boolean> {
  return hasSession(name);
}

/**
 * The logical id of the session's in-flight cur/ message, if any (§5.3) —
 * read-only (never a mutation, §10.8); feeds the exchange orphan sweep (§13.3).
 */
export async function inFlightId(root: string, key: string): Promise<string | null> {
  const item = await readCur(queuePaths(root, key));
  return item?.message.id ?? null;
}
