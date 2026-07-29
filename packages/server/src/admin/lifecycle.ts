// Operator-plane: agents/lifecycle (§8.5, FR-7/FR-8/FR-9). list returns names +
// status (§5.1); provision/kill/restart delegate to @teamai/lifecycle. kill is
// IMMEDIATE — it is the interrupt: the dispatcher's down-probe sees the loss
// mid-turn and frees cur/ for re-send (§5.1/FR-16b, §10.9). provision goes through
// the session's control lane (§8.5) so a status flip never races a turn in flight.
// restart is "kill + provision" where the kill is the SAME immediate interrupt
// (FR-96): it ends the in-flight turn OFF the lane FIRST, then re-provisions THROUGH
// the lane. Killing inside the lane instead would queue the whole restart behind the
// turn and, with /admin idleTimeout:0, hang the operator's request on a long/stuck
// turn (T145 follow-up — a never-idle turn made `restart` wait forever, SPEC §5.2).
//
// shutdown/reload (T85, FR-64/FR-65) are the GRACEFUL twins: the teardown
// strategy (agent.provision.teardown ?? types[agent.type].teardown, else the
// hard kill) asks the agent to quit itself before the kill settles it. shutdown
// is immediate like kill (it IS the graceful interrupt); reload runs through
// the control lane like restart.

import type { AgentTypeConfig, CommandConfig, RawModeConfig, TeardownConfig } from "@teamai/config";
import type { AgentStatus } from "@teamai/core";
import {
  type AgentTarget,
  type SessionControl,
  internalCommands,
  kill,
  provision,
  restart,
  runCommand,
  teardown,
} from "@teamai/lifecycle";
import { type ControlLane, IDLE_TEARDOWN_DEFAULT_MS, parseRetainAge } from "@teamai/orchestrator";
import { AdminError } from "./error";

export interface LifecycleRuntime {
  readonly name: string;
  readonly target: AgentTarget;
  /** The session dispatcher's control lane (§8.5). */
  readonly lane: ControlLane;
  /** Successful operator provision/restart — restores the auto-revive budget (FR-51, §5.1). */
  readonly onUp?: () => void;
}

export interface AgentSummary {
  readonly name: string;
  readonly session: string;
  readonly status: AgentStatus;
}

export interface LifecycleAdmin {
  list(): AgentSummary[];
  provision(name: string): Promise<AgentStatus>;
  kill(name: string): Promise<AgentStatus>;
  restart(name: string): Promise<AgentStatus>;
  /** Graceful kill (FR-64): teardown strategy first, hard kill as the fallback. */
  shutdown(name: string): Promise<AgentStatus>;
  /** Graceful restart (FR-64): teardown, then provision through the lane. */
  reload(name: string): Promise<AgentStatus>;
  /**
   * The agent's command list: merged config (FR-66: types.<type> ∪ agent, agent
   * wins by name) plus the internal commands appended (FR-67, every agent).
   */
  commands(name: string): readonly CommandConfig[];
  /** Run an allowed slash command; resolves to the captured pane output as-is. */
  command(name: string, slash: string): Promise<string>;
}

export interface LifecycleAdminDeps {
  readonly agents: ReadonlyMap<string, LifecycleRuntime>;
  readonly control: SessionControl;
  readonly configDir: string;
  /** Per-type defaults (config `types`, §7.1) — the teardown fallback (FR-64). */
  readonly types?: Readonly<Record<string, AgentTypeConfig>>;
}

/** Strategy resolution (FR-64): the agent override wins, the type default backs it. */
export function resolveTeardown(
  agent: AgentTarget["agent"],
  types: LifecycleAdminDeps["types"],
): TeardownConfig | undefined {
  return agent.provision?.teardown ?? types?.[agent.type]?.teardown;
}

/**
 * Idle auto-teardown window (FR-92, §5.1): resolve `teardown.idle` to ms. A
 * duration string parses (retain.age grammar §7.1); `true` ⇒ the 1h default;
 * absent or `false` ⇒ off (undefined). `idle` lives in the teardown block, so
 * this rides resolveTeardown's agent→type fallback — "a teardown block defined
 * for the agent or its type" is exactly the resolved strategy carrying it.
 */
export function resolveIdleTeardownMs(strategy: TeardownConfig | undefined): number | undefined {
  const idle = strategy?.idle;
  if (idle === undefined || idle === false) return undefined;
  return idle === true ? IDLE_TEARDOWN_DEFAULT_MS : parseRetainAge(idle);
}

/** Raw-mode capture rule resolution (FR-88): the agent override wins, the type
 * default backs it; absent ⇒ the default stabilize-and-capture (§14.2). */
export function resolveRaw(
  agent: AgentTarget["agent"],
  types: LifecycleAdminDeps["types"],
): RawModeConfig | undefined {
  return agent.raw ?? types?.[agent.type]?.raw;
}

/**
 * Merged command list (FR-66): the type list extended/overridden by the agent
 * list, keyed by slash name — an agent entry replaces the same-name type entry
 * (e.g. to change `keys`), new names append in declaration order.
 */
export function mergeCommands(
  agent: AgentTarget["agent"],
  types: LifecycleAdminDeps["types"],
): readonly CommandConfig[] {
  const merged = new Map<string, CommandConfig>();
  for (const command of types?.[agent.type]?.commands ?? []) merged.set(command.slash, command);
  for (const command of agent.commands ?? []) merged.set(command.slash, command);
  return [...merged.values()];
}

export function createLifecycleAdmin(deps: LifecycleAdminDeps): LifecycleAdmin {
  const runtime = (name: string): LifecycleRuntime => {
    const found = deps.agents.get(name);
    if (found === undefined) throw new AdminError(404, `unknown agent "${name}"`, "UNKNOWN_AGENT");
    return found;
  };
  const provisionDeps = { control: deps.control, configDir: deps.configDir };

  // A failed lifecycle op is an operator-facing conflict ("no provision block",
  // "session already exists"), not an internal error — surface its message.
  const attempt = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError(409, error instanceof Error ? error.message : String(error));
    }
  };

  return {
    list: () =>
      [...deps.agents.values()].map(({ name, target }) => ({
        name,
        session: target.agent.tmux,
        status: target.state.status,
      })),

    provision: (name) => {
      const { target, lane, onUp } = runtime(name);
      return attempt(async () => {
        const status = await lane.submit(() => provision(target, provisionDeps));
        onUp?.(); // the operator intervened — auto-revive re-armed (FR-51)
        return status;
      });
    },

    kill: (name) => attempt(() => kill(runtime(name).target, deps.control)), // immediate interrupt

    restart: (name) => {
      const { target, lane, onUp } = runtime(name);
      return attempt(async () => {
        // The interrupt (FR-9/FR-96): kill is IMMEDIATE and OFF the lane, so a mid-turn
        // restart ends the running turn NOW and the lane frees — it never queues behind
        // a long/stuck turn (which /admin idleTimeout:0 would turn into an indefinite
        // hang). cur/ is kept for the re-send (§10.9).
        await kill(target, deps.control);
        // Then the ordered kill+provision on the lane. The second kill is idempotent
        // (no-op if already down, or clears a session auto-revive raced up, FR-51).
        const status = await lane.submit(() => restart(target, provisionDeps));
        onUp?.(); // the operator intervened — auto-revive re-armed (FR-51)
        return status;
      });
    },

    // The graceful interrupt (FR-64): immediate like kill — a mid-turn agent is
    // ASKED to quit, the hard kill settles a refusal after the grace window.
    shutdown: (name) => {
      const { target } = runtime(name);
      return attempt(() =>
        teardown(target, {
          control: deps.control,
          strategy: resolveTeardown(target.agent, deps.types),
        }),
      );
    },

    reload: (name) => {
      const { target, lane, onUp } = runtime(name);
      return attempt(async () => {
        const status = await lane.submit(async () => {
          await teardown(target, {
            control: deps.control,
            strategy: resolveTeardown(target.agent, deps.types),
          });
          return provision(target, provisionDeps);
        });
        onUp?.(); // the operator intervened — auto-revive re-armed (FR-51)
        return status;
      });
    },

    // Config merge + internal commands appended (FR-67) — internal names cannot
    // be shadowed: config validation reserves them (§7.5).
    commands: (name) => [
      ...mergeCommands(runtime(name).target.agent, deps.types),
      ...[...internalCommands.values()].map(({ slash }) => ({ slash })),
    ],

    // Slash command (FR-66): only a CONFIGURED command runs — the list is the
    // allowlist; through the lane so it never interleaves with a turn (§10.1).
    // Internal commands (FR-67) dispatch FIRST and run system-side, laneless and
    // without the idle guard — read-only by contract, /screenshot exists exactly
    // to inspect a busy (possibly stuck) console without queueing behind it.
    command: (name, slash) => {
      const { target, lane } = runtime(name);
      const internal = internalCommands.get(slash);
      if (internal !== undefined) {
        return attempt(() => internal.run(target, { control: deps.control }));
      }
      const allowed = mergeCommands(target.agent, deps.types).find(
        (entry) => entry.slash === slash,
      );
      if (allowed === undefined) {
        throw new AdminError(404, `command "/${slash}" is not configured for "${name}"`);
      }
      return attempt(() =>
        lane.submit(() => runCommand(target, { control: deps.control, command: allowed })),
      );
    },
  };
}
