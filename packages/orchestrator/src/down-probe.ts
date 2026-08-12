// busy→down detection (§5.1, FR-16b, §8.2). For each busy session the dispatcher
// races the turn detector against this probe, which checks tmux has-session on its
// own cadence (NFR-10) — INDEPENDENT of the detect strategy. This matters for the
// native accelerator: when the session is killed the status file simply goes
// silent, so only the probe surfaces the loss. A confirmed absence frees the turn so cur/ is re-sent on
// restart (at-least-once, §10.9) instead of hanging forever waiting for idle.

import { hasSession as tmuxHasSession } from "@muxeon/tmux";

export interface DownProbeOptions {
  /** Session-existence check; default tmux has-session. Injectable for tests. */
  readonly hasSession?: (session: string) => Promise<boolean>;
  /** Probe cadence (NFR-10); default 1000ms. */
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once `session` is confirmed ABSENT (busy→down). Stops early — without
 * resolving — if `signal` aborts (the turn completed first).
 */
export async function waitForSessionDown(
  session: string,
  signal: AbortSignal,
  options: DownProbeOptions = {},
): Promise<void> {
  const hasSession = options.hasSession ?? tmuxHasSession;
  const intervalMs = options.intervalMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  while (!signal.aborted) {
    if (!(await hasSession(session))) return; // confirmed gone
    await sleep(intervalMs);
  }
}
