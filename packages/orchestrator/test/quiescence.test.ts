// Quiescence (§21.10, FR-200) — "observably done", the evidence behind
// `after: "quiet"`. What is pinned here is the difference from a status flag: a
// console that keeps redrawing is never quiet however idle the agent claims to
// be, and an unreadable one is UNKNOWN rather than still.

import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@muxeon/core";
import { QuiescenceTracker } from "../src/quiescence";

const T0 = 1_700_000_000_000;

/** A tracker over a scripted console, a scripted status and a movable clock. */
function harness(initial: { pane: string; status?: AgentStatus; tokens?: number }) {
  const world = {
    pane: initial.pane,
    status: initial.status ?? ("idle" as AgentStatus),
    tokens: initial.tokens,
    now: T0,
    captures: 0,
    fail: false,
  };
  const tracker = new QuiescenceTracker({
    capture: async () => {
      world.captures += 1;
      if (world.fail) throw new Error("no session");
      return world.pane;
    },
    status: () => world.status,
    tokens: () => world.tokens,
    now: () => world.now,
  });
  return { world, tracker };
}

describe("QuiescenceTracker (§21.10, FR-200)", () => {
  test("the first look is never stillness — there is nothing to compare it to", async () => {
    const { tracker } = harness({ pane: "READY>" });
    expect(await tracker.quietMs("dev", "dev-s")).toBe(0);
  });

  test("an unchanged pane accumulates stillness in real time", async () => {
    const { world, tracker } = harness({ pane: "READY>" });
    await tracker.quietMs("dev", "dev-s");
    world.now += 20_000;
    expect(await tracker.quietMs("dev", "dev-s")).toBe(20_000);
    world.now += 25_000;
    expect(await tracker.quietMs("dev", "dev-s")).toBe(45_000);
  });

  test("any console change resets the clock — this is the whole point", async () => {
    const { world, tracker } = harness({ pane: "READY>" });
    await tracker.quietMs("dev", "dev-s");
    world.now += 30_000;
    world.pane = "READY> thinking…";
    expect(await tracker.quietMs("dev", "dev-s")).toBe(0);
    world.now += 10_000;
    expect(await tracker.quietMs("dev", "dev-s")).toBe(10_000);
  });

  test("a moved token gauge resets it too, even when the pane redrew identically", async () => {
    const { world, tracker } = harness({ pane: "READY>", tokens: 1000 });
    await tracker.quietMs("dev", "dev-s");
    world.now += 30_000;
    world.tokens = 1400; // the same screen, but work happened (§12.8)
    expect(await tracker.quietMs("dev", "dev-s")).toBe(0);
  });

  test("a BUSY session is never quiet, however still its pane looks", async () => {
    const { world, tracker } = harness({ pane: "READY>", status: "busy" });
    await tracker.quietMs("dev", "dev-s");
    world.now += 60_000;
    expect(await tracker.quietMs("dev", "dev-s")).toBe(0);
    // …and the stillness it accumulated while busy is not credited retroactively
    world.status = "idle";
    expect(await tracker.quietMs("dev", "dev-s")).toBe(60_000);
  });

  test("a down agent and an unreadable pane are UNKNOWN, not quiet", async () => {
    const { world, tracker } = harness({ pane: "READY>", status: "down" });
    expect(await tracker.quietMs("dev", "dev-s")).toBeUndefined();
    expect(world.captures).toBe(0); // a down agent is not even captured
    world.status = "idle";
    world.fail = true;
    expect(await tracker.quietMs("dev", "dev-s")).toBeUndefined();
  });

  test("coming back from down starts a fresh observation, not the old one", async () => {
    const { world, tracker } = harness({ pane: "READY>" });
    await tracker.quietMs("dev", "dev-s");
    world.now += 60_000;
    world.status = "down";
    expect(await tracker.quietMs("dev", "dev-s")).toBeUndefined();
    world.status = "idle";
    expect(await tracker.quietMs("dev", "dev-s")).toBe(0); // not 60s of "stillness"
  });

  test("agents are tracked apart", async () => {
    const { world, tracker } = harness({ pane: "READY>" });
    await tracker.quietMs("dev", "dev-s");
    await tracker.quietMs("ops", "ops-s");
    world.now += 15_000;
    world.pane = "READY> ops typed something";
    expect(await tracker.quietMs("ops", "ops-s")).toBe(0);
    expect(await tracker.quietMs("dev", "dev-s")).toBe(0); // same shared pane script
  });
});
