// Auto-revive of a down agent (FR-50/FR-51, §5.1) — the bounded exception to
// OOS-9. One revive attempt per down-episode, WITH A STOP: the single budget is
// spent by any auto attempt (startup FR-50 or lazy FR-51) and restored only by
// proof of progress — a turn completing to done/ (noteDone) — or by an operator
// lifecycle op (reset, §8.5). A poison message (OOS-10) thus dies after its first
// auto-retry: provision→inject→crash with no done never loops, so no backoff
// machinery is needed.
//
// revive() never throws into the dispatcher loop: a failed provision logs through
// onError and leaves the agent down (operator territory, like attach-miss).

import type { AgentTarget, SessionControl } from "./context";
import { type ProvisionDeps, provision } from "./provision";

export interface ReviverDeps {
  readonly control: SessionControl;
  /** <config_dir> — provision's cwd fallback (§7.1). */
  readonly configDir: string;
  /** Failed attempt sink (warning surface); never rethrown. */
  readonly onError?: (error: unknown) => void;
}

export interface Reviver {
  /**
   * One auto attempt, budget-gated: a live tmux session → attach (down→idle, e.g.
   * the operator started it by hand); otherwise provision. Returns true when the
   * agent came up. Budget already spent / agent not down / no provision block →
   * false without consuming anything.
   */
  revive(): Promise<boolean>;
  /** Proof of progress (a done/ turn) — restores the budget. */
  noteDone(): void;
  /** Operator lifecycle op (provision/restart, §8.5) — restores the budget. */
  reset(): void;
}

export function createReviver(target: AgentTarget, deps: ReviverDeps): Reviver {
  const { agent, state } = target;
  const provisionDeps: ProvisionDeps = { control: deps.control, configDir: deps.configDir };
  let spent = false;
  return {
    async revive(): Promise<boolean> {
      if (spent || state.status !== "down" || agent.provision === undefined) return false;
      spent = true; // consumed by the ATTEMPT, not its success (the stop rule, §5.1)
      try {
        if (await deps.control.hasSession(agent.tmux)) {
          state.to("idle"); // session already live (manual start) — plain attach
          state.setOrigin("external"); // not ours → idle auto-teardown leaves it alone (FR-92)
        } else {
          await provision(target, provisionDeps); // provision marks origin "system"
        }
        return true;
      } catch (error) {
        deps.onError?.(error);
        return false; // stays down; the operator takes it from here
      }
    },
    noteDone(): void {
      spent = false;
    },
    reset(): void {
      spent = false;
    },
  };
}
