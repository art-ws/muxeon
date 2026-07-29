// Input injection (§4, §5.2). `sendLiteral` types a message body verbatim; `--`
// stops flag parsing so text starting with "-" (or any payload) is never read as a
// tmux option. `sendKeys` sends tmux key names (Enter, C-c, …) for submission and
// control. The dispatcher composes them: sendLiteral(rendered) then sendKeys(Enter).

import { exactTarget, tmuxOrThrow } from "./run";

/** Types `text` into the session literally (no key-name interpretation), no Enter. */
export async function sendLiteral(session: string, text: string): Promise<void> {
  await tmuxOrThrow(["send-keys", "-t", exactTarget(session), "-l", "--", text]);
}

/** Sends tmux key names (e.g. "Enter", "C-c") to the session. */
export async function sendKeys(session: string, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await tmuxOrThrow(["send-keys", "-t", exactTarget(session), ...keys]);
}
