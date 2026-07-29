// Idle auto-teardown sweeper (FR-92, §5.1): fires a graceful teardown for an
// agent the system raised once it has been idle with no transport activity for
// its window — never for a busy/down agent, never for an attach-only one, and
// not when a message arrived inside the window.

import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@teamai/core";
import {
  IDLE_TEARDOWN_DEFAULT_MS,
  IdleTeardownSweeper,
  type IdleTeardownTarget,
} from "../src/idle-teardown";

interface Kit {
  readonly target: IdleTeardownTarget;
  readonly torndown: string[];
  setStatus(s: AgentStatus): void;
  setSystem(v: boolean): void;
}

function makeKit(
  name: string,
  opts: { idleMs?: number; status?: AgentStatus; system?: boolean } = {},
): Kit {
  const torndown: string[] = [];
  let status: AgentStatus = opts.status ?? "idle";
  let system = opts.system ?? true;
  return {
    torndown,
    setStatus: (s) => {
      status = s;
    },
    setSystem: (v) => {
      system = v;
    },
    target: {
      name,
      idleMs: opts.idleMs ?? 1000,
      status: () => status,
      isSystemRaised: () => system,
      teardown: async () => {
        torndown.push(name);
        status = "down"; // mirror the real effect — a torn-down agent goes down
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("IdleTeardownSweeper (FR-92, §5.1)", () => {
  test("the default window is 1h", () => {
    expect(IDLE_TEARDOWN_DEFAULT_MS).toBe(3_600_000);
  });

  test("fires teardown after the window of continuous idle inactivity", async () => {
    let clock = 0;
    const kit = makeKit("a", { idleMs: 1000 });
    const sweeper = new IdleTeardownSweeper({ targets: [kit.target], now: () => clock });

    await sweeper.tick(); // first sight — starts the clock, no fire
    expect(kit.torndown).toEqual([]);

    clock = 999;
    await sweeper.tick(); // still within the window
    expect(kit.torndown).toEqual([]);

    clock = 1000;
    await sweeper.tick(); // window elapsed → fire
    await flush();
    expect(kit.torndown).toEqual(["a"]);
  });

  test("a busy agent is never reaped, and busy resets the clock", async () => {
    let clock = 0;
    const kit = makeKit("a", { idleMs: 1000 });
    const sweeper = new IdleTeardownSweeper({ targets: [kit.target], now: () => clock });
    await sweeper.tick(); // idle, clock starts at 0

    kit.setStatus("busy");
    clock = 2000;
    await sweeper.tick(); // busy → no fire, clock reset to 2000
    await flush();
    expect(kit.torndown).toEqual([]);

    kit.setStatus("idle");
    clock = 2500;
    await sweeper.tick(); // idle again but only 500ms since the busy reset
    await flush();
    expect(kit.torndown).toEqual([]);

    clock = 3001;
    await sweeper.tick(); // 1001ms idle since the reset → fire
    await flush();
    expect(kit.torndown).toEqual(["a"]);
  });

  test("an attach-only (external) session is never reaped", async () => {
    let clock = 0;
    const kit = makeKit("a", { idleMs: 1000, system: false });
    const sweeper = new IdleTeardownSweeper({ targets: [kit.target], now: () => clock });
    await sweeper.tick();
    clock = 10_000;
    await sweeper.tick();
    await flush();
    expect(kit.torndown).toEqual([]);
  });

  test("a routed message inside the window keeps the agent alive (noteActivity)", async () => {
    let clock = 0;
    const kit = makeKit("a", { idleMs: 1000 });
    const sweeper = new IdleTeardownSweeper({ targets: [kit.target], now: () => clock });
    await sweeper.tick(); // clock starts at 0

    clock = 900;
    sweeper.noteActivity("a"); // message at 900 → clock = 900
    clock = 1500;
    await sweeper.tick(); // only 600ms since activity → no fire
    await flush();
    expect(kit.torndown).toEqual([]);

    clock = 1901;
    await sweeper.tick(); // 1001ms since the 900 activity → fire
    await flush();
    expect(kit.torndown).toEqual(["a"]);
  });

  test("isStale reflects the window and ignores unknown names", () => {
    let clock = 0;
    const kit = makeKit("a", { idleMs: 1000 });
    const sweeper = new IdleTeardownSweeper({ targets: [kit.target], now: () => clock });
    expect(sweeper.isStale("a")).toBe(false); // no activity recorded yet
    sweeper.noteActivity("a");
    clock = 500;
    expect(sweeper.isStale("a")).toBe(false);
    clock = 1000;
    expect(sweeper.isStale("a")).toBe(true);
    expect(sweeper.isStale("nobody")).toBe(false);
  });

  test("noteActivity for an unknown participant is ignored", () => {
    const sweeper = new IdleTeardownSweeper({ targets: [makeKit("a").target], now: () => 0 });
    sweeper.noteActivity("operator"); // not a target — no throw, no effect
    expect(sweeper.isStale("operator")).toBe(false);
  });

  test("only one teardown op per agent is in flight across ticks", async () => {
    let clock = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const torndown: string[] = [];
    const target: IdleTeardownTarget = {
      name: "a",
      idleMs: 1000,
      status: () => "idle",
      isSystemRaised: () => true,
      teardown: async () => {
        torndown.push("a");
        await gate; // hold the op open across the next ticks
      },
    };
    const sweeper = new IdleTeardownSweeper({ targets: [target], now: () => clock });
    await sweeper.tick(); // start clock
    clock = 5000;
    await sweeper.tick(); // fire — op holds
    await sweeper.tick(); // still in flight → must NOT fire again
    await sweeper.tick();
    await flush();
    expect(torndown).toEqual(["a"]); // exactly once
    release();
  });
});
