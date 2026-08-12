// Shared fakes for the lifecycle unit tests: a recording SessionControl (no real
// tmux) and an AgentTarget builder with a minimal claude-like adapter.

import type { Adapter } from "@muxeon/adapters";
import type { AgentConfig, ProvisionConfig } from "@muxeon/config";
import type { AgentStatus } from "@muxeon/core";
import { AgentState } from "@muxeon/orchestrator";
import type { AgentTarget, NewSessionOptions, SessionControl } from "../src/context";

export interface ControlCalls {
  readonly newSession: { name: string; options: NewSessionOptions }[];
  readonly killed: string[];
  readonly literal: { name: string; text: string }[];
  readonly keys: { name: string; keys: string[] }[];
  readonly captured: string[];
}

export interface FakeControl extends SessionControl {
  readonly calls: ControlCalls;
}

/** A recording SessionControl. `present` seeds live sessions; `killThrows` simulates a kill error. */
export function fakeControl(
  opts: { present?: Iterable<string>; killThrows?: boolean; panes?: string[] } = {},
): FakeControl {
  const present = new Set(opts.present ?? []);
  const panes = [...(opts.panes ?? [])];
  const calls: ControlCalls = { newSession: [], killed: [], literal: [], keys: [], captured: [] };
  return {
    calls,
    capturePane: async (name) => {
      calls.captured.push(name);
      return panes.length > 1 ? (panes.shift() ?? "") : (panes[0] ?? "");
    },
    hasSession: async (name) => present.has(name),
    newSession: async (name, options) => {
      calls.newSession.push({ name, options });
      present.add(name);
    },
    killSession: async (name) => {
      calls.killed.push(name);
      if (opts.killThrows) throw new Error("kill failed");
      present.delete(name);
    },
    sendLiteral: async (name, text) => {
      calls.literal.push({ name, text });
    },
    sendKeys: async (name, ...keys) => {
      calls.keys.push({ name, keys });
    },
  };
}

export interface TargetKit {
  readonly target: AgentTarget;
}

export function makeTarget(
  opts: {
    name?: string;
    tmux?: string;
    cwd?: string;
    provision?: ProvisionConfig;
    status?: AgentStatus;
  } = {},
): TargetKit {
  const agent: AgentConfig = {
    name: opts.name ?? "researcher",
    type: "claude",
    tmux: opts.tmux ?? "researcher-session",
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.provision !== undefined ? { provision: opts.provision } : {}),
  };
  const adapter: Adapter = {
    type: "claude",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/, statusFile: (session) => `/status/${session.name}.json` },
    slashCommand: (name, args) =>
      args !== undefined && args.length > 0 ? `/${name} ${args}` : `/${name}`,
  };
  return {
    target: { agent, adapter, state: new AgentState(opts.status ?? "down") },
  };
}
