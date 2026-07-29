// Session lifecycle transport (§4): probe, provision, and kill tmux sessions. The
// provision command is passed as an argv array after `--`, so it is never built
// into a shell string on our side (§8.7). Detached (`-d`) so the server owns the
// session without attaching.

import { exactTarget, runTmux, tmuxOrThrow } from "./run";

export interface NewSessionOptions {
  /** Working directory for the new session (agent.cwd, else <config_dir>; §4). */
  readonly cwd?: string;
  /** Command argv, executed without a shell on our side (§8.7). */
  readonly command?: readonly string[];
  /** Extra environment for the session. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Whether a live tmux session with this exact name exists (§5.1 down-probe). */
export async function hasSession(session: string): Promise<boolean> {
  return (await runTmux(["has-session", "-t", exactTarget(session)])).exitCode === 0;
}

export async function newSession(session: string, options: NewSessionOptions = {}): Promise<void> {
  const args: string[] = ["new-session", "-d", "-s", session];
  if (options.cwd !== undefined) args.push("-c", options.cwd);
  if (options.env !== undefined) {
    for (const [key, value] of Object.entries(options.env)) args.push("-e", `${key}=${value}`);
  }
  if (options.command !== undefined && options.command.length > 0) {
    args.push("--", ...options.command);
  }
  await tmuxOrThrow(args);
}

export async function killSession(session: string): Promise<void> {
  await tmuxOrThrow(["kill-session", "-t", exactTarget(session)]);
}
