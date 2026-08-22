// The server's half of deferred self-chains (§21): the plane the agent-plane
// tools, the outbox drop and the admin surface all call, plus the executors that
// give the tick its three ways of touching an agent.
//
// Everything authority-shaped lives HERE rather than in @muxeon/schedules, and
// on purpose: the scheduler owns time, this owns permission (§10.33). Each gate
// is evaluated where and when the item fires, so a chain planned yesterday
// cannot run today on rights that were revoked in between.

import { randomUUID } from "node:crypto";
import type { CommandGrants, SessionAction, SessionGrants } from "@muxeon/core";
import {
  type Chain,
  type ChainInput,
  ScheduleError,
  type ScheduleLimits,
  isLive,
  planChain,
  validateChainId,
} from "@muxeon/schedules";
import type { ScheduleExecutors, ScheduleStore } from "@muxeon/schedules";

export interface ScheduleOutcome<T> {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly value?: T;
}

const failed = (code: string, message: string): ScheduleOutcome<never> => ({
  ok: false,
  code,
  message,
});

export interface SchedulePlaneDeps {
  readonly store: ScheduleStore;
  readonly limits: ScheduleLimits;
  /** Off ⇒ every entry point answers SCHEDULES_DISABLED, never a silent no-op. */
  readonly enabled: boolean;
  readonly isKnownAgent: (name: string) => boolean;
  readonly now?: () => number;
}

/**
 * Create / list / cancel — the operations behind `schedule_self`,
 * `list_schedules`, `cancel_schedule` (FR-190/FR-192), the outbox drop and the
 * admin endpoints. The agent's own name is supplied by the caller's identity, so
 * no entry point has ever seen a `to`.
 */
export class SchedulePlane {
  readonly #deps: SchedulePlaneDeps;
  readonly #now: () => number;

  constructor(deps: SchedulePlaneDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  async create(agent: string, input: ChainInput): Promise<ScheduleOutcome<Chain>> {
    if (!this.#deps.enabled) {
      return failed("SCHEDULES_DISABLED", "deferred schedules are switched off on this server");
    }
    if (!this.#deps.isKnownAgent(agent)) {
      return failed("UNKNOWN_PEER", `not an agent of this server: ${agent}`);
    }
    try {
      const live = (await this.#deps.store.list(agent)).filter(isLive).map((chain) => chain.id);
      const chain = planChain(input, {
        agent,
        now: this.#now(),
        limits: this.#deps.limits,
        liveIds: live,
        newId: () => randomUUID(),
      });
      await this.#deps.store.write(chain);
      return { ok: true, value: chain };
    } catch (error) {
      if (error instanceof ScheduleError) return failed(error.code, error.message);
      throw error;
    }
  }

  async list(agent: string): Promise<ScheduleOutcome<readonly Chain[]>> {
    if (!this.#deps.enabled) {
      return failed("SCHEDULES_DISABLED", "deferred schedules are switched off on this server");
    }
    return { ok: true, value: await this.#deps.store.list(agent) };
  }

  /** Every agent's chains — the operator view (§21.7), never an agent's. */
  async listAll(): Promise<readonly Chain[]> {
    return this.#deps.store.listAll();
  }

  /**
   * Cancel a whole chain or one item. Cancelling marks pending items
   * `cancelled` rather than deleting the file: the agent that comes back after a
   * `/clear` should be able to see that the plan was called off, not merely find
   * nothing (§21.4). A chain with nothing left pending is removed outright.
   */
  async cancel(agent: string, id: string, index?: number): Promise<ScheduleOutcome<number>> {
    if (!this.#deps.enabled) {
      return failed("SCHEDULES_DISABLED", "deferred schedules are switched off on this server");
    }
    try {
      validateChainId(id);
    } catch (error) {
      if (error instanceof ScheduleError) return failed(error.code, error.message);
      throw error;
    }
    const chain = await this.#deps.store.read(agent, id);
    if (chain === null) return failed("UNKNOWN_SCHEDULE", `no live schedule "${id}" for ${agent}`);
    let cancelled = 0;
    const items = chain.items.map((item) => {
      if (item.state !== "pending") return item;
      if (index !== undefined && item.index !== index) return item;
      cancelled += 1;
      return { ...item, state: "cancelled" as const };
    });
    if (cancelled === 0) {
      return failed(
        "UNKNOWN_SCHEDULE",
        index === undefined
          ? `schedule "${id}" has nothing pending left`
          : `item ${index} of "${id}" is not pending`,
      );
    }
    await this.#deps.store.write({ ...chain, items });
    return { ok: true, value: cancelled };
  }
}

export interface ExecutorDeps {
  /** Deliver a self-note through the router — the caller wires §21.3's notice form. */
  deliver(input: { agent: string; text: string; id: string }): Promise<void>;
  /** Run a slash on an agent's own pane, the FR-66 path (catalog + control-lane). */
  runCommand(input: { agent: string; slash: string }): Promise<string>;
  /** Lifecycle over an agent's own session, the FR-96 path. */
  control(input: { agent: string; action: SessionAction }): Promise<void>;
  statusOf(agent: string): Promise<"idle" | "busy" | "down">;
  isKnownAgent(name: string): boolean;
  readonly commandGrants: CommandGrants;
  readonly sessionGrants: SessionGrants;
}

/**
 * The three execution paths, each behind the ACL that already governs it — read
 * HERE, at firing time (§10.33). `permitsSelf` and not `permits(name, name, …)`:
 * a recipient wildcard means "any neighbour", and an agent is not its own
 * neighbour (§21.6).
 */
export function scheduleExecutors(deps: ExecutorDeps): ScheduleExecutors {
  return {
    deliver: deps.deliver,
    statusOf: deps.statusOf,
    isKnownAgent: deps.isKnownAgent,

    async runCommand({ agent, slash }) {
      if (!deps.commandGrants.permitsSelf(agent, slash)) {
        throw new Error(
          `COMMAND_DENIED: ${agent} has no self grant for "${slash}" (commandGrants.${agent}.${agent})`,
        );
      }
      await deps.runCommand({ agent, slash });
    },

    async control({ agent, action }) {
      if (!deps.sessionGrants.permitsSelf(agent, action)) {
        throw new Error(
          `CONTROL_DENIED: ${agent} has no self grant for "${action}" (sessionGrants.${agent}.${agent})`,
        );
      }
      await deps.control({ agent, action });
    },
  };
}

/** The wire shape of a chain for the tools and the admin surface (§21.4/§21.7). */
export function chainView(chain: Chain): Record<string, unknown> {
  return {
    id: chain.id,
    agent: chain.agent,
    created: new Date(chain.created).toISOString(),
    items: chain.items.map((item) => ({
      index: item.index,
      kind: item.kind,
      at: new Date(item.at).toISOString(),
      state: item.state,
      ...(item.text !== undefined ? { text: item.text } : {}),
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(item.control !== undefined ? { control: item.control } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    })),
  };
}
