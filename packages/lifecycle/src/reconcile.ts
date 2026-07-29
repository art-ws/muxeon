// Liveness reconcile (FR-93, §5.1): bring AgentState.status back in sync with the
// live tmux session for a NON-busy agent — the missing half of detection. The
// per-turn down-probe (FR-16b) only catches busy→down; a session started or killed
// by HAND after boot (or after teardown) leaves the status stale (an agent without
// a provision block can hang `down` over a live session indefinitely). The
// reconcile:
//   down + live ⇒ attach (down→idle), origin EXTERNAL — we did NOT raise it, so
//     idle auto-teardown (FR-92) leaves it alone, exactly like revive's live-attach;
//   idle + gone ⇒ idle→down (no cur/ to free — idle means no turn in flight);
//   busy ⇒ untouched, not even probed — that is the down-probe's turn (FR-16b),
//     and racing a live turn would corrupt it.
// Attach-only BY DESIGN: it NEVER provisions/spawns (a down agent with no session
// stays down — bring-up is FR-50/FR-51/operator territory), so OOS-9 is not widened.

import type { AgentStatus } from "@teamai/core";
import type { AgentTarget, SessionControl } from "./context";

export async function reconcileLiveness(
  target: AgentTarget,
  control: SessionControl,
): Promise<AgentStatus> {
  const status = target.state.status;
  if (status === "busy") return status; // FR-16b owns busy→down — never race a turn
  const up = await control.hasSession(target.agent.tmux);
  if (up && status === "down") {
    target.state.to("idle"); // came up out-of-band (hand start) — plain attach
    target.state.setOrigin("external"); // not ours → idle auto-teardown leaves it alone (FR-92)
  } else if (!up && status === "idle") {
    target.state.to("down"); // killed while idle, out-of-band
  }
  return target.state.status;
}
