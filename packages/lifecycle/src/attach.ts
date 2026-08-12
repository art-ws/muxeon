// Attach to an already-running agent session (§4, FR-7). This only probes: a live
// tmux session → idle, a missing one → down (NOT fatal — the server still boots,
// §5.1). Unlike provision, attach does NOT install the native hook: for an
// attach-only agent the hook is an EXTERNAL precondition (predefined outside Muxeon,
// like the agent's own MCP client, §5.2). The adapter may degrade to output-fallback
// if no status file appears.

import type { AgentStatus } from "@muxeon/core";
import type { AgentTarget, SessionControl } from "./context";

export async function attach(target: AgentTarget, control: SessionControl): Promise<AgentStatus> {
  const up = await control.hasSession(target.agent.tmux);
  target.state.to(up ? "idle" : "down");
  return target.state.status;
}
