// Provision a new agent session (§4, FR-8). A detached tmux session is created in
// the agent's working directory, running provision.command as an ARGV ARRAY — never
// a shell string (§8.7). Agent configuration is untouched (FR-11b, §5.2) — no hooks,
// no settings; detection works via the output front. The agent comes up idle (§5.1).

import type { AgentStatus } from "@teamai/core";
import type { AgentTarget, NewSessionOptions, SessionControl } from "./context";

export interface ProvisionDeps {
  readonly control: SessionControl;
  /** <config_dir> — the fallback cwd when neither provision.cwd nor agent.cwd is set (§7.1). */
  readonly configDir: string;
}

/**
 * Normalize a provision command to an argv array — the §8.7 command-injection
 * defense. A string is taken as a SINGLE program token (it is NOT whitespace-split:
 * splitting would smuggle back the quoting/escaping ambiguity a shell brings);
 * commands that need arguments must use the array form. Either way nothing is ever
 * handed to a shell, so `"; rm -rf ~"` is an (absent) program name, not a command.
 */
export function toArgv(command: string | readonly string[]): string[] {
  return typeof command === "string" ? [command] : [...command];
}

export async function provision(target: AgentTarget, deps: ProvisionDeps): Promise<AgentStatus> {
  const { agent, state } = target;
  if (agent.provision === undefined) {
    throw new Error(`agent "${agent.name}" has no provision block (attach-only, §4)`);
  }
  // Working dir precedence (§7.1/§8.7): explicit provision.cwd, else agent.cwd, else
  // <config_dir>. command is argv (no shell); env is explicit when present.
  const options: NewSessionOptions = {
    cwd: agent.provision.cwd ?? agent.cwd ?? deps.configDir,
    command: toArgv(agent.provision.command),
    ...(agent.provision.env !== undefined ? { env: agent.provision.env } : {}),
  };
  await deps.control.newSession(agent.tmux, options);
  state.to("idle"); // down → idle (came up, §5.1)
  state.setOrigin("system"); // WE raised this session — idle auto-teardown may retire it (FR-92)
  return state.status;
}
