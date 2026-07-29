// AgentStatus state-machine (§5.1) — the source for get_status (§8.1). `down` = no
// tmux session; idle/busy come from the adapter's detect (§5.2). One AgentState per
// session, owned by the orchestrator.

import type { AgentStatus } from "@teamai/core";

// Allowed non-identity transitions (§5.1):
//   down → idle         (comes up: attach / provision / restart)
//   idle → busy | down  (message injected | session lost)
//   busy → idle | down  (turn complete §5.2 | session lost §5.1, FR-16b)
// down → busy is illegal — an agent must come up idle before it can be busy.
const ALLOWED: Record<AgentStatus, readonly AgentStatus[]> = {
  down: ["idle"],
  idle: ["busy", "down"],
  busy: ["idle", "down"],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}

/**
 * How the LIVE session came up (§5.1, FR-92): `system` — TEAMAI provisioned it
 * (provision/restart/reload/auto-revive); `external` — we attached to a session
 * the operator started, or none is up yet. Idle auto-teardown only retires what
 * we raised (`system`), so a hand-started agent is never reaped. Every come-up
 * path sets it explicitly (provision ⇒ system, attach ⇒ external); the default
 * `external` covers a startup attach to a live session.
 */
export type SessionOrigin = "system" | "external";

export class AgentState {
  #status: AgentStatus;
  #origin: SessionOrigin;

  constructor(initial: AgentStatus = "down", origin: SessionOrigin = "external") {
    this.#status = initial;
    this.#origin = origin;
  }

  get status(): AgentStatus {
    return this.#status;
  }

  /** Whether the live session was raised by TEAMAI vs attached (§5.1, FR-92). */
  get origin(): SessionOrigin {
    return this.#origin;
  }

  /** Record how the current session came up — set on every come-up path (§5.1). */
  setOrigin(origin: SessionOrigin): void {
    this.#origin = origin;
  }

  /** Applies a transition, throwing on an illegal one (§5.1). */
  to(next: AgentStatus): void {
    if (!canTransition(this.#status, next)) {
      throw new Error(`illegal status transition: ${this.#status} -> ${next}`);
    }
    this.#status = next;
  }
}
