// Send a slash/stop command to an agent (§4, FR-9). The command text is rendered by
// the agent type's adapter (§8.3) — MUXEON does not know any agent's command syntax —
// then injected literally and submitted with Enter, the same two-step the dispatcher
// uses for messages (§5.2). This is a control action, not a queued message: it goes
// straight to the session, bypassing the queue.

import type { AgentTarget, SessionControl } from "./context";

export interface SlashOptions {
  readonly control: SessionControl;
  readonly name: string;
  readonly args?: string;
}

export async function sendSlash(target: AgentTarget, options: SlashOptions): Promise<void> {
  const text = target.adapter.slashCommand(options.name, options.args);
  await options.control.sendLiteral(target.agent.tmux, text);
  await options.control.sendKeys(target.agent.tmux, "Enter");
}
