// Subprocess runner for the tmux CLI (§4, FR-5). All tmux interaction goes through
// here; arguments are passed as an argv array to Bun.spawn, so there is no shell
// interpolation on our side (relevant to the §8.7 argv-without-shell guarantee for
// provisioning).

export interface TmuxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Exact-match `-t` target for a session. tmux resolves a bare `-t name` by PREFIX
 * (and only falls back to it when no exact name matches), so an agent named `dev`
 * silently resolves to a live `devops` session when no `dev` session exists —
 * misrouting send-keys/capture and making has-session/kill-session hit the wrong
 * agent. The `=name:` form pins an exact session (the `=` forces exact match; the
 * trailing `:` keeps it valid as a session/window/pane target alike). (§4, §5.1)
 */
export function exactTarget(session: string): string {
  return `=${session}:`;
}

export async function runTmux(args: readonly string[]): Promise<TmuxResult> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function tmuxOrThrow(args: readonly string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await runTmux(args);
  if (exitCode !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** Whether a usable tmux binary is present (for gating integration tests / startup). */
export async function hasTmux(): Promise<boolean> {
  try {
    return (await runTmux(["-V"])).exitCode === 0;
  } catch {
    return false;
  }
}
