// Kill an agent session (§4, FR-9). The tmux session is destroyed and the agent
// goes down (§5.1). Its queue keeps accumulating while down and is delivered on the
// next come-up (at-least-once, §10.9). Idempotent: killing an already-gone session
// is not an error — it just confirms down.

import type { AgentStatus } from "@teamai/core";
import type { AgentTarget, SessionControl } from "./context";

export async function kill(target: AgentTarget, control: SessionControl): Promise<AgentStatus> {
  try {
    await control.killSession(target.agent.tmux);
  } catch (error) {
    // Already gone is fine (we wanted it down); a still-present session is a real failure.
    if (await control.hasSession(target.agent.tmux)) throw error;
  }
  target.state.to("down");
  return target.state.status;
}
