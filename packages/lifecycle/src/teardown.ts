// Graceful teardown (FR-64, §5.1): ask the agent to quit ITSELF — a slash
// command in the adapter's syntax (FR-9) and/or raw tmux keys — then give the
// session a grace window to die before the hard kill-session. No strategy ⇒
// this IS kill(). Either way the agent ends down (§5.1); its queue keeps
// accumulating while down and is delivered on the next come-up (§10.9).

import type { TeardownConfig } from "@muxeon/config";
import type { AgentStatus } from "@muxeon/core";
import type { AgentTarget, SessionControl } from "./context";
import { kill } from "./kill";

export const TEARDOWN_DEFAULT_GRACE_MS = 5000;
/** Paste-settle before Enter (the FR-58 finding): a same-burst Enter is swallowed. */
const SLASH_SETTLE_MS = 200;
const GRACE_POLL_MS = 200;

export interface TeardownDeps {
  readonly control: SessionControl;
  /**
   * Resolved strategy — agent.provision.teardown ?? types[agent.type].teardown
   * (FR-64); absent ⇒ straight hard kill (the pre-FR-64 behavior).
   */
  readonly strategy?: TeardownConfig | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export async function teardown(target: AgentTarget, deps: TeardownDeps): Promise<AgentStatus> {
  const strategy = deps.strategy;
  if (strategy === undefined) return kill(target, deps.control);
  // A strategy with no graceful ask — e.g. an idle-only teardown block (FR-92,
  // which carries `idle` but no slash/keys) — IS the hard kill (FR-64).
  const hasGraceful =
    strategy.slash !== undefined || (strategy.keys !== undefined && strategy.keys.length > 0);
  if (!hasGraceful) return kill(target, deps.control);
  const session = target.agent.tmux;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  if (!(await deps.control.hasSession(session))) {
    target.state.to("down"); // already gone — just confirm down (idempotent)
    return target.state.status;
  }

  // The graceful ask. A dying/raced session refusing input is fine — the grace
  // poll (and ultimately the hard kill) settles it either way.
  try {
    if (strategy.slash !== undefined) {
      await deps.control.sendLiteral(session, target.adapter.slashCommand(strategy.slash));
      await sleep(SLASH_SETTLE_MS); // separate input bursts (FR-58)
      await deps.control.sendKeys(session, "Enter");
    }
    if (strategy.keys !== undefined && strategy.keys.length > 0) {
      await deps.control.sendKeys(session, ...strategy.keys);
    }
  } catch {
    // fall through to the grace poll / hard kill
  }

  const deadline = now() + (strategy.graceMs ?? TEARDOWN_DEFAULT_GRACE_MS);
  while (now() < deadline) {
    if (!(await deps.control.hasSession(session))) {
      target.state.to("down"); // died gracefully — no kill needed
      return target.state.status;
    }
    await sleep(GRACE_POLL_MS);
  }
  return kill(target, deps.control); // grace expired — the hard kill settles it
}
