// User wiring (§17.5, FR-124/FR-127) — the composition root's users half.
//
// Every user owns ONE pseudo-session queue `<root>/<user>/` (§5.3) whatever the
// number of channels they are bound to (invariant §10.23), served by the SAME
// EgressDispatcher the legacy operator uses (§8.2). Its deliver port is the
// user's sink:
//
//   1. durable append into the user's history `<user>/<peer>.jsonl` (§12.3) —
//      THAT is the delivery: the record is complete()d the moment it is written,
//      so a closed browser or a silent telegram never blocks the queue;
//   2. best-effort fan-out of a PUSH over every bound channel (webchat WS,
//      telegram/slack chat of the bound alias). A push failure is a warning, never
//      a re-send: the history already holds the record and the panel reads the
//      tail on reconnect (decision §17.10-3 — no per-channel catch-up cursors).
//
// The history lives in @muxeon/webchat and the queue in @muxeon/orchestrator, so
// this sink can only be assembled HERE, in the server layer — exactly like the
// legacy channel wiring next door (§8).

import { join } from "node:path";
import type { UserConfig } from "@muxeon/config";
import type { Signal } from "@muxeon/core";
import {
  EgressDispatcher,
  loadSessionDoneIds,
  parseRetainAge,
  sessionPaths,
} from "@muxeon/orchestrator";
import { HistoryStore } from "@muxeon/webchat";

/** One bound channel a user's egress pushes into (§17.5). */
export interface UserPushTarget {
  /** Channel instance name (§17.2) — for the warning text only. */
  readonly channel: string;
  /** Push one record; a throw is logged and dropped (best-effort, FR-124). */
  push(signal: Signal): Promise<void>;
}

export interface UserRuntime {
  readonly name: string;
  readonly config: UserConfig;
  readonly history: HistoryStore;
  readonly egress: EgressDispatcher;
  /** Push targets, filled in as the connectors start (§8.2 start order). */
  readonly targets: UserPushTarget[];
}

export interface WireUsersOptions {
  readonly users: readonly UserConfig[];
  /** Queue root <root> (§5.3) — the pseudo-session queues live under it. */
  readonly root: string;
  /** <config_dir> (§7.4) — the per-user history root (§12.3/§17.7). */
  readonly configDir: string;
  /** History double cap from the webchat channel's `history.retain` (§12.3). */
  readonly historyRetain?: { readonly age?: string; readonly count?: number };
  /** Aborts the egress loops (shared with the agent dispatchers). */
  readonly signal: AbortSignal;
  /**
   * Start the egress loops (default true). `false` builds the dispatchers without
   * running them — the same seam `autoStart` gives the agent dispatchers, so a
   * test can drain a user's queue with `pump()` on its own schedule.
   */
  readonly start?: boolean;
  /** Reports a best-effort push failure (§17.5); default stderr. */
  readonly onPushError?: (user: string, channel: string, error: unknown) => void;
}

export interface UsersHandle {
  readonly users: ReadonlyMap<string, UserRuntime>;
  /** The running egress loops; joined on shutdown like the channels'. */
  readonly runs: readonly Promise<void>[];
}

const warn = (user: string, channel: string, error: unknown): void => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `muxeon: warning: push to "${user}" over channel "${channel}" failed: ${reason} (§17.5 best-effort)\n`,
  );
};

/**
 * Builds one runtime per user: history + egress dispatcher over their queue, with
 * the sink wired. The dispatcher loops are returned unstarted-but-running (like
 * wireChannels) so the caller joins them on shutdown.
 */
export async function wireUsers(options: WireUsersOptions): Promise<UsersHandle> {
  const users = new Map<string, UserRuntime>();
  const runs: Promise<void>[] = [];
  const onPushError = options.onPushError ?? warn;
  const retain = {
    ...(options.historyRetain?.age !== undefined
      ? { ageMs: parseRetainAge(options.historyRetain.age) }
      : {}),
    ...(options.historyRetain?.count !== undefined ? { count: options.historyRetain.count } : {}),
  };

  for (const user of options.users) {
    const history = new HistoryStore({
      dir: join(options.configDir, "webchat", "history", user.name),
      operator: user.name, // the pair key is the OTHER side (§12.3), user or agent
      retain,
    });
    const egress = new EgressDispatcher({
      paths: sessionPaths(options.root, user.name),
      doneIds: await loadSessionDoneIds(options.root, user.name),
    });
    const targets: UserPushTarget[] = [];
    // The sink (§17.5): history first — it IS the delivery. Only a FAILED append
    // throws, which leaves the record in cur/ for re-send (at-least-once §10.9).
    egress.registerDeliver(async (signal) => {
      const fresh = await history.append(signal);
      if (!fresh) return; // a duplicate id: already delivered (§10.9)
      for (const target of targets) {
        try {
          await target.push(signal);
        } catch (error) {
          onPushError(user.name, target.channel, error);
        }
      }
    });
    if (options.start ?? true) runs.push(egress.run(options.signal));
    users.set(user.name, { name: user.name, config: user, history, egress, targets });
  }

  return { users, runs };
}
