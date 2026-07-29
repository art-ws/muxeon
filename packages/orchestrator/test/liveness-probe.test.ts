// Liveness-probe sweeper (FR-93, §5.1): mirror of the idle-teardown sweep — it
// reconciles each non-busy agent's status with its live tmux session every tick.
// Owns timing/eligibility/dedup only (the reconcile itself runs on the control
// lane, wired in bootstrap). Never reconciles a busy agent (FR-16b owns busy→down).

import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@teamai/core";
import {
  LIVENESS_PROBE_DEFAULT_MS,
  LivenessProbeSweeper,
  type LivenessTarget,
} from "../src/liveness-probe";

interface Kit {
  readonly target: LivenessTarget;
  readonly reconciled: string[];
  setStatus(s: AgentStatus): void;
}

function makeKit(name: string, opts: { status?: AgentStatus } = {}): Kit {
  const reconciled: string[] = [];
  let status: AgentStatus = opts.status ?? "down";
  return {
    reconciled,
    setStatus: (s) => {
      status = s;
    },
    target: {
      name,
      status: () => status,
      reconcile: async () => {
        reconciled.push(name);
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("LivenessProbeSweeper (FR-93, §5.1)", () => {
  test("the default cadence is 2s", () => {
    expect(LIVENESS_PROBE_DEFAULT_MS).toBe(2000);
  });

  test("reconciles a down target on a tick (catches a hand-start)", async () => {
    const kit = makeKit("a", { status: "down" });
    const sweeper = new LivenessProbeSweeper({ targets: [kit.target] });
    await sweeper.tick();
    await flush();
    expect(kit.reconciled).toEqual(["a"]);
  });

  test("reconciles an idle target on a tick (catches a hand-kill while idle)", async () => {
    const kit = makeKit("a", { status: "idle" });
    const sweeper = new LivenessProbeSweeper({ targets: [kit.target] });
    await sweeper.tick();
    await flush();
    expect(kit.reconciled).toEqual(["a"]);
  });

  test("never reconciles a busy target (FR-16b owns busy→down)", async () => {
    const kit = makeKit("a", { status: "busy" });
    const sweeper = new LivenessProbeSweeper({ targets: [kit.target] });
    await sweeper.tick();
    await sweeper.tick();
    await flush();
    expect(kit.reconciled).toEqual([]);
  });

  test("only one reconcile op per agent is in flight across ticks", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reconciled: string[] = [];
    const target: LivenessTarget = {
      name: "a",
      status: () => "down",
      reconcile: async () => {
        reconciled.push("a");
        await gate; // hold the op open across the next ticks
      },
    };
    const sweeper = new LivenessProbeSweeper({ targets: [target] });
    await sweeper.tick(); // fire — op holds
    await sweeper.tick(); // still in flight → must NOT fire again
    await sweeper.tick();
    await flush();
    expect(reconciled).toEqual(["a"]); // exactly once until released
    release();
  });

  test("a reconcile that throws is retried next tick (in-flight cleared)", async () => {
    let calls = 0;
    const target: LivenessTarget = {
      name: "a",
      status: () => "down",
      reconcile: async () => {
        calls += 1;
        throw new Error("probe failed");
      },
    };
    const sweeper = new LivenessProbeSweeper({ targets: [target] });
    await sweeper.tick();
    await flush();
    await sweeper.tick();
    await flush();
    expect(calls).toBe(2); // not stuck in-flight after a throw
  });
});
