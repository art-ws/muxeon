import { describe, expect, test } from "bun:test";
import { prime, tickRoutine } from "../src/index";
import { cronFor } from "../src/time";
import { memStore, ms, recRouter, routine } from "./helpers";

describe("DST semantics (§6.3)", () => {
  test("fall-back fold runs the ambiguous local time ONCE, not twice", () => {
    // 2026-11-01 America/New_York: 02:00 → 01:00, so 01:30 occurs twice.
    const runs = cronFor("30 1 * * *", "America/New_York")
      .nextRuns(2, new Date("2026-10-31T12:00:00Z"))
      .map((d) => d.toISOString());
    expect(runs[0]).toBe("2026-11-01T05:30:00.000Z"); // the FIRST 01:30 only
    expect(runs[1]?.startsWith("2026-11-02")).toBe(true); // next is the following day — no repeat
  });

  test("spring-forward gap resolves deterministically to a single fire", async () => {
    // 2026-03-08 America/New_York: 02:00 → 03:00, so 02:30 does not exist. croner
    // resolves it to one deterministic instant (no phantom/double fire) — §6.3 intent.
    const router = recRouter();
    const state = memStore();
    const c = routine({ id: "g", schedule: "30 2 * * *", tz: "America/New_York" });
    await state.write("researcher", "g", { lastRun: ms("2026-03-07T12:00:00Z") });

    const out = await tickRoutine(c, { router, state, now: () => ms("2026-03-08T12:00:00Z") });
    expect(out.outcome).toBe("fired");
    expect(router.sent).toHaveLength(1); // exactly once across the gap
  });
});

describe("skip-missed on restart (§6.3)", () => {
  test("downtime ticks are absorbed without firing; the next future tick runs normally", async () => {
    const router = recRouter();
    const state = memStore();
    const c = routine({ id: "d", schedule: "0 9 * * *", tz: "UTC" });
    // last fired 03-01 09:00Z; server then down until 03-05 14:00Z (missed 03-02..03-05).
    await state.write("researcher", "d", { lastRun: ms("2026-03-01T09:00:00Z") });

    const absorbed = await prime([c], { router, state, now: () => ms("2026-03-05T14:00:00Z") });
    expect(absorbed).toBe(1);
    expect(router.sent).toHaveLength(0); // not caught up (catch-up is OOS-12)
    expect(await state.read("researcher", "d")).toEqual({ lastRun: ms("2026-03-05T09:00:00Z") }); // now-aligned

    // a tick the next day fires the next future occurrence normally (§10.5)
    const out = await tickRoutine(c, { router, state, now: () => ms("2026-03-06T09:30:00Z") });
    expect(out.outcome).toBe("fired");
    expect(out.signalId).toBe("routine:researcher:d:2026-03-06T09:00:00.000Z");
  });

  test("priming a routine with nothing missed leaves it untouched", async () => {
    const router = recRouter();
    const state = memStore();
    const c = routine({ id: "n", schedule: "0 9 * * *", tz: "UTC" });
    await state.write("researcher", "n", { lastRun: ms("2026-03-05T09:00:00Z") });
    expect(await prime([c], { router, state, now: () => ms("2026-03-05T12:00:00Z") })).toBe(0);
    expect(await state.read("researcher", "n")).toEqual({ lastRun: ms("2026-03-05T09:00:00Z") });
  });
});
