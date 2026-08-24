// Internal slash commands (T90, FR-67, §8.5): commands EXECUTED BY Muxeon, not
// typed into the agent's console — available on every agent without any config.
// They share the operator surface of configured commands (FR-66: same endpoints,
// same dropdown, same as-is output) but not the execution discipline: an internal
// command NEVER INJECTS INPUT into the console, so it deliberately skips both the
// idle guard and the control lane. That is the point of /screenshot: inspect the
// console of a possibly-STUCK busy agent right now — a laned command would queue
// behind the very turn being diagnosed. It is also what lets /pause and /unpause
// (§16.5, FR-198) work mid-turn: they move a transport flag, not a cursor. A
// future internal command that TYPES anything would need the lane and the guard
// back; the registry stays console-free until a requirement says otherwise (R3).
//
// The names are reserved at config validation (§7.5): a configured {slash}
// cannot shadow an internal one — INTERNAL_COMMAND_SLASHES (config) is the
// single name list, and a test pins this registry to it.

import type { INTERNAL_COMMAND_SLASHES } from "@muxeon/config";
import type { AgentTarget, SessionControl } from "./context";

/**
 * The pause registry as an internal command needs it (§16.4): the same object the
 * router and the dispatchers read and the operator plane mutates. Absent ⇒ pause
 * is not wired, and /pause says so instead of silently doing nothing.
 */
export interface PausePort {
  has(name: string): boolean;
  /** Applies the desired state; true when it CHANGED (persist only then, §16.4). */
  set(name: string, paused: boolean): boolean;
  /** Mirror the snapshot to state/paused.json — atomic, best-effort. */
  persist(): Promise<void>;
}

export interface InternalCommandDeps {
  readonly control: SessionControl;
  /** Wired by the composition root; absent in surfaces that have no pause registry. */
  readonly pause?: PausePort;
}

/** A system-side slash command that never types into the console (FR-67). */
export interface InternalCommand {
  readonly slash: (typeof INTERNAL_COMMAND_SLASHES)[number];
  /** One line for the operator surfaces (UI tooltip / docs). */
  readonly describe: string;
  run(target: AgentTarget, deps: InternalCommandDeps): Promise<string>;
}

/**
 * /screenshot — the current visible console as-is (one capture, no
 * stabilization: the snapshot of NOW is the answer, even mid-redraw).
 */
const screenshot: InternalCommand = {
  slash: "screenshot",
  describe: "capture the agent's console as-is (system-side, works while busy)",
  async run(target, deps) {
    if (target.state.status === "down") {
      throw new Error(`agent "${target.agent.name}" is down — no console to screenshot`);
    }
    return deps.control.capturePane(target.agent.tmux);
  },
};

/**
 * Set or clear the pause flag (§16, FR-198) — the same registry and the same
 * persist discipline as the operator's own mutation (§16.5): the flag takes
 * effect in-process immediately, and only a CHANGE is mirrored to disk.
 * Idempotent by construction: `set` reports whether anything moved.
 */
async function applyPause(
  target: AgentTarget,
  deps: InternalCommandDeps,
  paused: boolean,
): Promise<string> {
  const pause = deps.pause;
  const name = target.agent.name;
  if (pause === undefined) throw new Error("pause is not wired on this server (§16.4)");
  const changed = pause.set(name, paused);
  if (changed) {
    // A failed mirror must not fail the command: the flag is already in effect,
    // persistence is only what makes it survive a restart (§16.4).
    await pause.persist().catch(() => undefined);
  }
  if (paused) {
    return changed
      ? `paused "${name}" — messages to it are refused (AGENT_PAUSED) and its queue is held until /unpause`
      : `"${name}" was already paused`;
  }
  return changed
    ? `unpaused "${name}" — delivery resumes and the queue drains`
    : `"${name}" was not paused`;
}

/**
 * /pause — declare "deliver nothing to me" (§16.1). Works in ANY session status,
 * including `busy` and `down`: the flag is transport state, not a session
 * operation, which is exactly why an agent can wrap its own sequence in it
 * (FR-198) without waiting to be idle.
 */
const pause: InternalCommand = {
  slash: "pause",
  describe: "stop delivering messages to this agent (transport pause §16; works while busy)",
  run: (target, deps) => applyPause(target, deps, true),
};

/** /unpause — clear the flag; the queue held during the pause drains at once. */
const unpause: InternalCommand = {
  slash: "unpause",
  describe: "resume delivery to this agent and drain what was held (§16)",
  run: (target, deps) => applyPause(target, deps, false),
};

/** Registry keyed by slash name — the FR-67 catalog. */
export const internalCommands: ReadonlyMap<string, InternalCommand> = new Map(
  [screenshot, pause, unpause].map((command) => [command.slash, command]),
);

/** Is this slash executed system-side (laneless, no idle guard)? — FR-67/FR-198. */
export function isInternalCommand(slash: string): boolean {
  return internalCommands.has(slash);
}
