// Operator-plane: queue edits (§8.5, NFR-9). peek is a read-only maildir
// inspection; cancel and requeue are MUTATIONS submitted to the session's
// ControlLane and executed by its own dispatcher loop between turns — the single
// owner of pending/cur is preserved (§10.8) and there is no TOCTOU with dequeue.
// cancel of an id already claimed into cur/ is refused; requeue regenerates
// `<unix_ms>-<seq>` (FIFO tail) keeping the logical id; an id already in the
// done/ window is an explicit no-op (§10.9).

import type {
  ControlLane,
  PeekResult,
  QueuePaths,
  QueueStamp,
  RequeueResult,
} from "@muxeon/orchestrator";
import { cancelPendingById, peekQueue, requeueFailedById } from "@muxeon/orchestrator";
import { AdminError } from "./error";

/** One participant's queue runtime: its paths, owning lane, and dedup window. */
export interface QueueRuntime {
  readonly paths: QueuePaths;
  readonly lane: ControlLane;
  readonly doneIds: ReadonlySet<string>;
}

export interface QueuesAdminDeps {
  /** Resolve a participant name (agent or operator) to its queue runtime. */
  readonly resolve: (name: string) => QueueRuntime | undefined;
  /** Fresh filename stamp from the shared producer counter (§5.3). */
  readonly stamp: () => QueueStamp;
}

export interface QueuesAdmin {
  peek(name: string): Promise<PeekResult>;
  cancel(name: string, id: string): Promise<{ cancelled: true }>;
  requeue(name: string, id: string): Promise<RequeueResult>;
}

export function createQueuesAdmin(deps: QueuesAdminDeps): QueuesAdmin {
  const runtime = (name: string): QueueRuntime => {
    const found = deps.resolve(name);
    if (found === undefined) {
      throw new AdminError(404, `unknown participant "${name}"`, "UNKNOWN_PARTICIPANT");
    }
    return found;
  };

  return {
    peek: (name) => peekQueue(runtime(name).paths),

    cancel: async (name, id) => {
      const { paths, lane } = runtime(name);
      const outcome = await lane.submit(() => cancelPendingById(paths, id));
      if (outcome === "in-flight") {
        throw new AdminError(409, `"${id}" is already in flight (cur/) — cannot cancel`, outcome);
      }
      if (outcome === "not-found") {
        throw new AdminError(404, `no pending record with id "${id}"`, outcome);
      }
      return { cancelled: true };
    },

    requeue: async (name, id) => {
      const { paths, lane, doneIds } = runtime(name);
      const result = await lane.submit(() => requeueFailedById(paths, id, deps.stamp(), doneIds));
      if (result.outcome === "not-found") {
        throw new AdminError(404, `no failed record with id "${id}"`, result.outcome);
      }
      return result; // "requeued" (with the new filename) or the explicit "already-done" no-op
    },
  };
}
