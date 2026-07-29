// Restart an agent (§4, FR-9, §5.1): kill the session, then provision it fresh. The
// kill leaves any in-flight cur/ message in place (it was never completed); coming
// back up idle lets the session's dispatcher re-send that message (recover, §10.9)
// and drain the pending/ that accumulated while down — at-least-once, tolerant of
// duplicates. The dispatcher is the single owner of pending/cur (§10.8), so restart
// only flips the session; it never touches the queue directly.
//
// Mid-turn restart (operator restarts an agent WHILE it is processing) is serialized
// by the operator-plane control loop (§8.5, T31); this primitive is the normal
// kill→provision path.

import type { AgentStatus } from "@teamai/core";
import type { AgentTarget } from "./context";
import { kill } from "./kill";
import { type ProvisionDeps, provision } from "./provision";

export async function restart(target: AgentTarget, deps: ProvisionDeps): Promise<AgentStatus> {
  await kill(target, deps.control); // → down; in-flight cur/ kept for re-send (§10.9)
  return provision(target, deps); // → idle; the dispatcher loop recovers cur/ + drains pending/
}
