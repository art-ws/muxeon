// Internal slash commands (T90, FR-67, §8.5): commands EXECUTED BY TEAMAI, not
// typed into the agent's console — available on every agent without any config.
// They share the operator surface of configured commands (FR-66: same endpoints,
// same dropdown, same as-is output) but not the execution discipline: an internal
// command is READ-ONLY by contract — it never injects input, so it deliberately
// skips both the idle guard and the control lane. That is the point of
// /screenshot: inspect the console of a possibly-STUCK busy agent right now —
// a laned command would queue behind the very turn being diagnosed. A future
// mutating internal command would need the lane and the guard back; the
// registry stays read-only until a requirement says otherwise (R3).
//
// The names are reserved at config validation (§7.5): a configured {slash}
// cannot shadow an internal one — INTERNAL_COMMAND_SLASHES (config) is the
// single name list, and a test pins this registry to it.

import type { INTERNAL_COMMAND_SLASHES } from "@teamai/config";
import type { AgentTarget, SessionControl } from "./context";

export interface InternalCommandDeps {
  readonly control: SessionControl;
}

/** A system-side, read-only slash command (FR-67). */
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

/** Registry keyed by slash name — the FR-67 catalog. */
export const internalCommands: ReadonlyMap<string, InternalCommand> = new Map(
  [screenshot].map((command) => [command.slash, command]),
);
