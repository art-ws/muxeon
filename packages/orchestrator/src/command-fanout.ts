// Operator slash-command to a set of selectors, targeting the INTERSECTION of
// resolved agents (§15.8, FR-115, invariant §10.18). This is the transport-
// agnostic orchestration: resolve the intersection (intersect.ts), then dispatch
// the command to each agent via an injected `dispatchOne`. The fan-out lives
// OUTSIDE the router (commands act on a single agent's console via the control-
// lane, not router.route) — so this is a plain helper each operator surface
// (admin plane, panel) binds with its own `dispatchOne` (and, for the panel, its
// own per-agent neighbour gate).

import type { BroadcastTarget } from "./broadcast";
import { intersectSelectors } from "./intersect";

export interface CommandFanoutEntry {
  readonly to: string;
  readonly ok: boolean;
  /** Success: the captured console output as-is (FR-66). Failure: the reason. */
  readonly output?: string;
  /** Set on failure — e.g. COMMAND_FAILED (no command/busy/down) or COMMAND_DENIED (not a neighbour). */
  readonly code?: string;
}

export interface CommandFanoutOk {
  readonly ok: true;
  readonly kind: "command-fanout";
  readonly slash: string;
  readonly selectors: readonly string[];
  /** The resolved intersection the command was dispatched to (deterministic order). */
  readonly targets: readonly string[];
  readonly fanout: readonly CommandFanoutEntry[];
}

export interface CommandFanoutError {
  readonly ok: false;
  readonly code: "INVALID_ARGS" | "UNKNOWN_SELECTOR";
  readonly message: string;
}

export type CommandFanoutResult = CommandFanoutOk | CommandFanoutError;

export interface CommandFanoutDeps {
  readonly resolveBroadcast: (to: string) => BroadcastTarget | null;
  readonly isAgent: (name: string) => boolean;
  /**
   * Dispatch the slash to ONE agent. MUST resolve an entry, never reject —
   * per-agent failures (busy/down/no command/not-a-neighbour) are mapped to a
   * `code` so one bad agent doesn't sink the whole fan-out (§10.18).
   */
  readonly dispatchOne: (agent: string, slash: string) => Promise<CommandFanoutEntry>;
}

/**
 * Apply one slash-command to the intersection of `selectors` (§15.8). Empty
 * intersection → `ok:true` with an empty `fanout` (not an error). An unknown
 * selector (neither group/tag/agent) → `UNKNOWN_SELECTOR` (the whole request is
 * rejected — it is an input error, not a silent empty result); an empty selector
 * list → `INVALID_ARGS`.
 */
export async function commandFanout(
  slash: string,
  selectors: readonly string[],
  deps: CommandFanoutDeps,
): Promise<CommandFanoutResult> {
  if (selectors.length === 0) {
    return { ok: false, code: "INVALID_ARGS", message: "selectors[] must be a non-empty list" };
  }
  const { agents, unknown } = intersectSelectors(selectors, deps.resolveBroadcast, deps.isAgent);
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "UNKNOWN_SELECTOR",
      message: `unknown selector(s): ${unknown.join(", ")}`,
    };
  }
  // Independent agents (distinct sessions/lanes) → dispatch concurrently.
  const fanout = await Promise.all(agents.map((agent) => deps.dispatchOne(agent, slash)));
  return { ok: true, kind: "command-fanout", slash, selectors, targets: agents, fanout };
}
