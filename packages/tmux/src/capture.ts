// Output capture (§5.2): read the visible pane so the dispatcher's output-fallback
// detector can match the ready prompt. `-p` prints the pane to stdout.

import { exactTarget, tmuxOrThrow } from "./run";

export interface CaptureOptions {
  /**
   * Include this many SCROLLBACK lines above the visible screen (`-S -<n>`) — the
   * console-fallback reply scrape (§8.2, FR-47) needs more than one screen: a long
   * answer scrolls off before the turn ends. Detection (§5.2) keeps the default
   * visible-only capture.
   */
  readonly historyLines?: number;
}

export async function capturePane(session: string, options: CaptureOptions = {}): Promise<string> {
  const args = ["capture-pane", "-t", exactTarget(session), "-p"];
  if (options.historyLines !== undefined) args.push("-S", `-${options.historyLines}`);
  return tmuxOrThrow(args);
}
