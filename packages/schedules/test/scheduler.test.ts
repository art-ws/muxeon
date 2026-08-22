// What the tick decides (§21.5) and what it then does (§21.5 commit order).
// The clock is injected and the paths are stubs: these cases are about WHEN an
// item fires, whether a busy agent is waited for, and what a failure does to the
// rest of the chain — none of which needs a real pane.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Chain, DEFAULT_LIMITS, type ScheduleLimits } from "../src/chain";
import { dueItems, startSchedules } from "../src/scheduler";
import { createFsScheduleStore } from "../src/store";

const T0 = 1_700_000_000_000;
const LIMITS: ScheduleLimits = { ...DEFAULT_LIMITS, idleWaitMs: 60_000, catchUpGraceMs: 600_000 };

const chain = (items: Partial<Chain["items"][number]>[]): Chain => ({
  id: "c1",
  agent: "dev",
  created: T0,
  items: items.map((item, index) => ({
    index,
    kind: "message" as const,
    at: T0,
    state: "pending" as const,
    ...item,
  })) as Chain["items"],
});

describe("what a tick decides (dueItems)", () => {
  test("nothing is due before its hour", () => {
    const verdicts = dueItems(chain([{ at: T0 + 60_000, text: "a" }]), T0, LIMITS, "idle");
    expect(verdicts).toEqual([]);
  });

  test("a message fires whatever the agent is doing — the queue IS the wait", () => {
    for (const status of ["idle", "busy", "down"] as const) {
      const verdicts = dueItems(chain([{ text: "a" }]), T0, LIMITS, status);
      expect(verdicts.map((v) => v.kind)).toEqual(["fire"]);
    }
  });

  test("a slash waits for a busy agent instead of firing into a guaranteed refusal", () => {
    const marks = new Map<string, number>();
    const one = chain([{ kind: "command", command: "clear" }]);
    expect(dueItems(one, T0, LIMITS, "busy", marks).map((v) => v.kind)).toEqual(["wait"]);
    // …and it is still waiting a little later
    expect(dueItems(one, T0 + 30_000, LIMITS, "busy", marks).map((v) => v.kind)).toEqual(["wait"]);
    // …and it fires the moment the agent frees up
    expect(dueItems(one, T0 + 31_000, LIMITS, "idle", marks).map((v) => v.kind)).toEqual(["fire"]);
  });

  // The wait is counted from the first tick that found the item due, not from
  // its due time: that is when the waiting actually started (§21.9-Q2).
  test("the idle wait runs out and the item fails with a reason, not silently", () => {
    const marks = new Map<string, number>();
    const one = chain([{ kind: "command", command: "clear" }]);
    dueItems(one, T0, LIMITS, "busy", marks);
    const [verdict] = dueItems(one, T0 + 61_000, LIMITS, "busy", marks);
    expect(verdict?.kind).toBe("fail");
    expect(verdict?.kind === "fail" && verdict.reason).toContain("idle wait");
  });

  // Downtime has a signature: an item long past due that this scheduler has
  // never seen due before (§21.9-Q3).
  test("an item missed while the coordinator was down fires late — within the grace", () => {
    const late = chain([{ text: "restore" }]);
    expect(dueItems(late, T0 + 300_000, LIMITS, "idle").map((v) => v.kind)).toEqual(["fire"]);
  });

  test("…and is dropped, with the lateness named, once past the grace", () => {
    const late = chain([{ text: "restore" }]);
    const [verdict] = dueItems(late, T0 + 700_000, LIMITS, "idle");
    expect(verdict?.kind).toBe("drop");
    expect(verdict?.kind === "drop" && verdict.reason).toContain("coordinator was down");
  });

  test("a busy agent does NOT turn into a downtime drop — waiting is not being down", () => {
    const marks = new Map<string, number>();
    const one = chain([{ kind: "command", command: "clear" }]);
    dueItems(one, T0, LIMITS, "busy", marks); // seen due while the server was up
    const [verdict] = dueItems(one, T0 + 700_000, LIMITS, "busy", marks);
    expect(verdict?.kind).toBe("fail"); // the idle wait expired — not "dropped"
  });

  test("settled items are never revisited", () => {
    const done = chain([
      { text: "a", state: "fired" },
      { text: "b", state: "failed" },
      { text: "c" },
    ]);
    expect(dueItems(done, T0, LIMITS, "idle").map((v) => v.item.index)).toEqual([2]);
  });
});

describe("what a tick then does", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const harness = async (chains: Chain[], time: () => number) => {
    const dir = await mkdtemp(join(tmpdir(), "muxeon-schedules-"));
    dirs.push(dir);
    const store = createFsScheduleStore(dir);
    for (const one of chains) await store.write(one);
    const calls: string[] = [];
    const logs: string[] = [];
    const scheduler = startSchedules({
      store,
      limits: LIMITS,
      now: time,
      log: (line) => logs.push(line),
      executors: {
        deliver: async ({ text, id }) => {
          calls.push(`deliver ${id} ${text}`);
        },
        runCommand: async ({ slash }) => {
          calls.push(`command ${slash}`);
          if (slash === "boom") throw new Error("COMMAND_FAILED: no such command");
        },
        control: async ({ action }) => {
          calls.push(`control ${action}`);
        },
        statusOf: async () => "idle",
        isKnownAgent: (name) => name !== "ghost",
      },
    });
    return { store, scheduler, calls, logs };
  };

  test("the self-healing chain runs in order, each item at its hour", async () => {
    let clock = T0;
    const { scheduler, calls, store } = await harness(
      [
        chain([
          { text: "save state" },
          { kind: "command", command: "clear", at: T0 + 180_000 },
          { text: "restore state", at: T0 + 240_000 },
        ]),
      ],
      () => clock,
    );
    await scheduler.tick();
    expect(calls).toEqual(["deliver c1:0 save state"]);
    clock = T0 + 200_000;
    await scheduler.tick();
    expect(calls).toEqual(["deliver c1:0 save state", "command clear"]);
    clock = T0 + 250_000;
    await scheduler.tick();
    expect(calls.at(-1)).toBe("deliver c1:2 restore state");
    const stored = await store.read("dev", "c1");
    expect(stored?.items.map((item) => item.state)).toEqual(["fired", "fired", "fired"]);
    await scheduler.stop();
  });

  // "Чисто механически по таймеру": the coordinator does not branch on results,
  // so one item's failure neither cancels the rest nor shifts their hour.
  test("a failing item is recorded with its reason and the chain goes on", async () => {
    let clock = T0;
    const { scheduler, calls, store } = await harness(
      [
        chain([
          { kind: "command", command: "boom" },
          { text: "after", at: T0 + 60_000 },
        ]),
      ],
      () => clock,
    );
    await scheduler.tick();
    clock = T0 + 61_000;
    await scheduler.tick();
    const stored = await store.read("dev", "c1");
    expect(stored?.items[0]?.state).toBe("failed");
    expect(stored?.items[0]?.error).toContain("COMMAND_FAILED");
    expect(stored?.items[1]?.state).toBe("fired");
    expect(calls).toEqual(["command boom", "deliver c1:1 after"]);
    await scheduler.stop();
  });

  test("a chain whose agent left the topology is pruned, not fired", async () => {
    const orphan = { ...chain([{ text: "hello" }]), agent: "ghost" };
    const { scheduler, calls, store } = await harness([orphan], () => T0);
    await scheduler.tick();
    expect(calls).toEqual([]);
    expect(await store.read("ghost", "c1")).toBeNull();
    await scheduler.stop();
  });

  test("firing survives a restart: the mark is on disk, the item does not repeat", async () => {
    const { scheduler, calls, store } = await harness([chain([{ text: "once" }])], () => T0);
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    expect(calls).toEqual(["deliver c1:0 once"]);
    expect((await store.read("dev", "c1"))?.items[0]?.state).toBe("fired");
    await scheduler.stop();
  });
});
