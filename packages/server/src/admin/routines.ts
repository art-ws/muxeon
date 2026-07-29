// Operator-plane: routines CRUD + kill-switch + run-once (§8.5, FR-20/FR-23).
// Files are the source of truth (§6.2): put/delete/enable/disable edit the central
// MD files atomically (the scheduler picks changes up on its re-scan, §6); state
// (lastRun/done) is read for display only. run-once is a manual fire OUTSIDE the
// schedule: it ignores enabled:false, never touches done/lastRun (§10.4 governs
// autoruns only), and sends from the OWNER agent through the router (§6.2/§10.2).

import { join } from "node:path";
import {
  type Routine,
  type RoutineState,
  type StateStore,
  deleteRoutineFile,
  discoverCentralRoutines,
  parseFrontmatter,
  setEnabledInContent,
  writeRoutineFile,
} from "@teamai/routines";
import { type SignalRouter, buildSignal } from "@teamai/signals";
import { AdminError } from "./error";

export interface RoutineSummary {
  readonly id: string;
  readonly owner: string;
  readonly target: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly at?: string;
  readonly tz?: string;
  readonly state: RoutineState | null;
}

export interface RoutinesAdmin {
  list(owner?: string): Promise<RoutineSummary[]>;
  get(owner: string, id: string): Promise<RoutineSummary & { body: string }>;
  put(owner: string, id: string, content: string): Promise<{ owner: string; id: string }>;
  delete(owner: string, id: string): Promise<{ deleted: true }>;
  setEnabled(owner: string, id: string, enabled: boolean): Promise<{ enabled: boolean }>;
  runOnce(owner: string, id: string): Promise<{ id: string; queued: true; target: string }>;
}

export interface RoutinesAdminDeps {
  /** Central routines base, <config_dir>/routines (§6.2). */
  readonly routinesDir: string;
  readonly knownAgents: readonly string[];
  readonly state: StateStore;
  readonly router: SignalRouter;
}

export function createRoutinesAdmin(deps: RoutinesAdminDeps): RoutinesAdmin {
  const discover = (): Routine[] =>
    discoverCentralRoutines({ routinesDir: deps.routinesDir, knownAgents: deps.knownAgents })
      .routines;

  const find = (owner: string, id: string): Routine => {
    const routine = discover().find((r) => r.owner === owner && r.id === id);
    if (routine === undefined) {
      throw new AdminError(404, `no routine "${id}" for owner "${owner}"`, "UNKNOWN_ROUTINE");
    }
    return routine;
  };

  const requireOwner = (owner: string): void => {
    if (!deps.knownAgents.includes(owner)) {
      throw new AdminError(400, `unknown owner "${owner}" (not a configured agent)`, "BAD_OWNER");
    }
  };

  // §8.7/§10.11: put derives a FILENAME from the id, so the id must be a single
  // safe path segment — otherwise "../x" (or an URL-encoded variant) would move
  // the write outside <routinesDir>/<owner>/. Discovery-side ids never build
  // paths (their source file is already known), so this gate guards put alone.
  const SAFE_ROUTINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const requireSafeId = (id: string): void => {
    if (!SAFE_ROUTINE_ID.test(id) || id.includes("..")) {
      throw new AdminError(
        400,
        `routine id must be a safe name ([A-Za-z0-9._-], no leading dot, no "..")`,
        "BAD_ROUTINE",
      );
    }
  };

  const summarize = async (routine: Routine): Promise<RoutineSummary> => ({
    id: routine.id,
    owner: routine.owner,
    target: routine.target,
    schedule: routine.schedule,
    enabled: routine.enabled,
    ...(routine.at !== undefined ? { at: routine.at } : {}),
    ...(routine.tz !== undefined ? { tz: routine.tz } : {}),
    state: await deps.state.read(routine.owner, routine.id),
  });

  return {
    list: async (owner) => {
      const routines = discover().filter((r) => owner === undefined || r.owner === owner);
      return Promise.all(routines.map(summarize));
    },

    get: async (owner, id) => {
      const routine = find(owner, id);
      return { ...(await summarize(routine)), body: routine.body };
    },

    put: async (owner, id, content) => {
      requireOwner(owner);
      requireSafeId(id);
      let specId: string;
      try {
        specId = parseFrontmatter(content).id;
      } catch (error) {
        throw new AdminError(
          400,
          `invalid routine file: ${error instanceof Error ? error.message : String(error)}`,
          "BAD_ROUTINE",
        );
      }
      if (specId !== id) {
        throw new AdminError(400, `frontmatter id "${specId}" must equal "${id}"`, "BAD_ROUTINE");
      }
      await writeRoutineFile(join(deps.routinesDir, owner, `${id}.md`), content);
      return { owner, id };
    },

    delete: async (owner, id) => {
      await deleteRoutineFile(find(owner, id).source);
      return { deleted: true };
    },

    setEnabled: async (owner, id, enabled) => {
      const routine = find(owner, id);
      const content = await Bun.file(routine.source).text();
      await writeRoutineFile(routine.source, setEnabledInContent(content, enabled));
      return { enabled };
    },

    runOnce: async (owner, id) => {
      const routine = find(owner, id); // enabled:false is ignored by design (§8.5)
      const message = buildSignal({
        from: routine.owner, // owner-as-source (§6.2)
        to: routine.target,
        payload: routine.body,
        origin: `routine:${routine.id}:run-once`,
      });
      const result = await deps.router.route(message);
      if (!result.ok) {
        if (result.code === "UNKNOWN_PEER") {
          throw new AdminError(404, `unknown target "${routine.target}"`, result.code);
        }
        if (result.code === "WIP_LIMIT") {
          // Backpressure (FR-104): Too Many Requests — the target's queue is full.
          throw new AdminError(
            429,
            `"${routine.target}" is at its WIP limit (${result.limit}); ${result.depth} in flight`,
            result.code,
          );
        }
        throw new AdminError(
          403,
          `no topology edge ${routine.owner} — ${routine.target}`,
          result.code,
        );
      }
      return { id: message.id, queued: true, target: routine.target };
    },
  };
}
