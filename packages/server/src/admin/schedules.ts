// Operator view of deferred self-chains (§21.7, FR-192). Two operations and no
// more: SEE what an agent has armed for itself, and DISARM it.
//
// There is deliberately no "create" here. Planning is the agent's own act
// (§21.2) — an operator who wants a timed prompt has routines (§6), which are
// files they own. What the operator does need is the ability to look and to
// revoke, because this subsystem types into live terminals by the clock and the
// agent that armed it may have cleared its own memory of doing so.

import type { SchedulePlane } from "../schedules";
import { chainView } from "../schedules";
import { AdminError } from "./error";

export interface SchedulesAdmin {
  /** Every live chain, or one agent's; newest last. */
  list(agent?: string): Promise<readonly Record<string, unknown>[]>;
  /** Cancel a whole chain or one item; a refusal names itself, never a no-op. */
  cancel(agent: string, id: string, index?: number): Promise<{ id: string; cancelled: number }>;
}

export function createSchedulesAdmin(deps: {
  /** Read LAZILY: the plane is assembled after the admin surface (§21 step 11b). */
  plane: () => SchedulePlane | undefined;
}): SchedulesAdmin {
  const planeOr404 = (): SchedulePlane => {
    const plane = deps.plane();
    if (plane === undefined) {
      throw new AdminError(404, "schedules are not wired on this server", "SCHEDULES_DISABLED");
    }
    return plane;
  };
  return {
    async list(agent) {
      const plane = deps.plane();
      if (plane === undefined) return [];
      const chains = await plane.listAll();
      return chains
        .filter((chain) => agent === undefined || chain.agent === agent)
        .map((chain) => chainView(chain));
    },

    async cancel(agent, id, index) {
      const outcome = await planeOr404().cancel(agent, id, index);
      if (!outcome.ok) {
        throw new AdminError(
          outcome.code === "UNKNOWN_SCHEDULE" ? 404 : 400,
          outcome.message ?? "refused",
          outcome.code ?? "SCHEDULE_FAILED",
        );
      }
      return { id, cancelled: outcome.value ?? 0 };
    },
  };
}
