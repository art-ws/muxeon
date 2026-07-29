// Run an operator slash command on an agent (T86, FR-66, §8.5): the adapter
// renders the slash syntax (FR-9), Enter goes as its OWN input burst after a
// settle pause (the FR-58 finding), then the visible pane is captured AS-IS
// once it STABILIZES — two consecutive identical looks — capped for long
// redraws (/compact). The key DSL (T118/T119, FR-80): the `keys` script
// interleaves keystrokes, quoted literals and delays around the `capture`
// point — steps before it navigate the command's dialog, steps after it
// return the agent to the normal prompt (dialogs: "capture Escape").
//
// Guarded: only an idle agent takes a command — busy would interleave with a
// turn (§10.1), down has nothing to type into. The caller additionally
// serializes through the session's control lane (§8.5), so a turn cannot
// START mid-command either.
//
// Raw mode (FR-88, §14.2) reuses the SAME stabilize-capture + key-DSL machinery
// (captureConsole) — minus the slash injection: the operator's text was already
// injected and the turn already completed, so the rule only governs how the
// console is captured back.

import { type KeyScript, type KeyStep, parseKeyScript } from "@teamai/config";
import type { CommandConfig, RawModeConfig } from "@teamai/config";
import type { AgentTarget, SessionControl } from "./context";

const COMMAND_SETTLE_MS = 200; // separate input bursts (FR-58)
const STABILIZE_POLL_MS = 400;
const STABILIZE_CAP_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CaptureDeps {
  readonly control: SessionControl;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Run a key script around a stabilized pane capture (FR-80): the `before` steps
 * navigate (executed before stabilization), the pane is captured as-is once two
 * consecutive looks match (capped for long redraws), then the `after` steps
 * return the agent to its prompt. Shared by slash commands (FR-66) and raw-mode
 * capture (FR-88). Each input goes as its OWN burst with a settle pause (FR-58).
 */
async function captureWithScript(
  session: string,
  script: KeyScript,
  deps: CaptureDeps,
): Promise<string> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const runSteps = async (steps: readonly KeyStep[]): Promise<void> => {
    for (const step of steps) {
      if (step.kind === "delay") {
        await sleep(step.ms);
        continue;
      }
      await sleep(COMMAND_SETTLE_MS); // every input goes as its OWN burst (FR-58)
      if (step.kind === "key") await deps.control.sendKeys(session, step.key);
      else await deps.control.sendLiteral(session, step.text);
    }
  };

  await runSteps(script.before); // dialog navigation — BEFORE the capture

  let pane = "";
  const deadline = now() + STABILIZE_CAP_MS;
  for (;;) {
    await sleep(STABILIZE_POLL_MS);
    const next = await deps.control.capturePane(session);
    const stable = next === pane;
    pane = next;
    if (stable || now() >= deadline) break;
  }

  await runSteps(script.after); // back to the normal prompt — AFTER the capture
  return pane;
}

export interface RunCommandDeps extends CaptureDeps {
  readonly command: CommandConfig;
}

/** Sends the slash command and returns the agent's console output verbatim. */
export async function runCommand(target: AgentTarget, deps: RunCommandDeps): Promise<string> {
  const { agent, adapter, state } = target;
  if (state.status !== "idle") {
    throw new Error(`agent "${agent.name}" is ${state.status} — commands need an idle session`);
  }
  const session = agent.tmux;
  const sleep = deps.sleep ?? defaultSleep;
  // the key script (FR-80) — already validated at config load (§7.5)
  const script =
    deps.command.keys !== undefined ? parseKeyScript(deps.command.keys) : { before: [], after: [] };

  await deps.control.sendLiteral(session, adapter.slashCommand(deps.command.slash));
  await sleep(COMMAND_SETTLE_MS);
  await deps.control.sendKeys(session, "Enter");

  return captureWithScript(session, script, deps);
}

export interface CaptureConsoleDeps extends CaptureDeps {
  /** The resolved raw rule (resolveRaw); absent ⇒ the default stabilize-and-capture. */
  readonly raw?: RawModeConfig;
}

/**
 * Capture the agent's console as-is for a finished RAW turn (FR-88, §14.2). The
 * dispatcher already injected the operator's text verbatim and awaited busy→idle,
 * so no slash is sent — the configured key-DSL rule (`raw.keys`, default empty)
 * only governs the capture: stabilize, snapshot the visible pane, return to the
 * prompt. No idle/down guard: the caller (the session's own dispatcher loop)
 * holds the turn, so the session is live and serialized by construction (§10.1).
 */
export async function captureConsole(
  target: AgentTarget,
  deps: CaptureConsoleDeps,
): Promise<string> {
  const keys = deps.raw?.keys;
  const script = keys !== undefined ? parseKeyScript(keys) : { before: [], after: [] };
  return captureWithScript(target.agent.tmux, script, deps);
}
