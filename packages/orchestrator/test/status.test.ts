import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@muxeon/core";
import { AgentState, canTransition, clockView } from "../src/status";

describe("AgentStatus state-machine (§5.1, FR-10)", () => {
  test("starts down by default and is readable", () => {
    expect(new AgentState().status).toBe("down");
    expect(new AgentState("idle").status).toBe("idle");
  });

  test("valid lifecycle: down → idle → busy → idle → down", () => {
    const state = new AgentState();
    state.to("idle");
    expect(state.status).toBe("idle");
    state.to("busy");
    expect(state.status).toBe("busy");
    state.to("idle");
    state.to("down");
    expect(state.status).toBe("down");
  });

  test("busy → down (session lost while working, §5.1/FR-16b) is allowed", () => {
    const state = new AgentState("busy");
    state.to("down");
    expect(state.status).toBe("down");
  });

  test("down → busy is illegal (must come up idle first)", () => {
    expect(() => new AgentState("down").to("busy")).toThrow();
  });

  test("same-state transitions are idempotent no-ops", () => {
    const state = new AgentState("idle");
    state.to("idle");
    expect(state.status).toBe("idle");
  });

  test("session origin (§5.1, FR-92): defaults external, settable, independent of status", () => {
    expect(new AgentState().origin).toBe("external");
    expect(new AgentState("idle", "system").origin).toBe("system");
    const state = new AgentState("down");
    state.setOrigin("system"); // provision raised it
    expect(state.origin).toBe("system");
    state.to("idle");
    expect(state.origin).toBe("system"); // a status transition does not touch origin
    state.setOrigin("external"); // a later manual attach
    expect(state.origin).toBe("external");
  });

  test("a transition does not touch the clock's activity stamps of other sources", () => {
    const state = new AgentState("idle", "external", () => 5_000);
    state.noteActivity("transport", 1_000);
    state.to("busy");
    expect(state.clock.signals).toEqual({ transport: 1_000, turn: 5_000 });
  });

  test("canTransition encodes the §5.1 graph", () => {
    expect(canTransition("down", "idle")).toBe(true);
    expect(canTransition("idle", "busy")).toBe(true);
    expect(canTransition("idle", "down")).toBe(true);
    expect(canTransition("busy", "idle")).toBe(true);
    expect(canTransition("busy", "down")).toBe(true);
    expect(canTransition("down", "busy")).toBe(false);
    const all: AgentStatus[] = ["idle", "busy", "down"];
    for (const status of all) expect(canTransition(status, status)).toBe(true);
  });
});

// The session clock (§5.5, FR-194/FR-195): a status says WHAT an agent is, the
// clock says FOR HOW LONG. Everything here is an OBSERVATION — an unknown stamp
// stays absent rather than being invented (§10.34).
describe("session clock (§5.5, FR-194/FR-195)", () => {
  /** A state with a controllable clock — the tests move `at` themselves. */
  const stateAt = (initial: AgentStatus, at: () => number): AgentState =>
    new AgentState(initial, "external", at);

  test("a fresh state has no start and no activity — nothing has been witnessed", () => {
    const state = new AgentState();
    expect(state.startedAt).toBeUndefined();
    expect(state.clock).toEqual({ signals: {} });
  });

  test("coming up stamps startedAt and counts as a `session` signal", () => {
    let now = 1_000;
    const state = stateAt("down", () => now);
    now = 7_000;
    state.to("idle");
    expect(state.startedAt).toBe(7_000);
    expect(state.clock).toEqual({
      startedAt: 7_000,
      lastActivityAt: 7_000,
      lastActivity: "session",
      signals: { session: 7_000 },
    });
  });

  test("markStarted replaces the stamp with the session's real birth time (attach)", () => {
    let now = 9_000;
    const state = stateAt("idle", () => now);
    state.markStarted(1_500); // tmux says the session is older than our knowledge of it
    expect(state.startedAt).toBe(1_500);
    now = 10_000;
    expect(clockView(state, 8_000, now).uptimeMs).toBe(8_500);
  });

  test("markStarted ignores an unknown time and a down agent — no invented uptime", () => {
    const state = new AgentState("idle");
    state.markStarted(undefined);
    expect(state.startedAt).toBeUndefined();
    const down = new AgentState("down");
    down.markStarted(1_000);
    expect(down.startedAt).toBeUndefined();
  });

  test("a turn boundary (idle ↔ busy) is a `turn` signal", () => {
    let now = 100;
    const state = stateAt("idle", () => now);
    now = 200;
    state.to("busy");
    now = 900;
    state.to("idle");
    expect(state.clock).toMatchObject({ lastActivityAt: 900, lastActivity: "turn" });
  });

  test("going down drops the uptime but KEEPS the last sign of life", () => {
    let now = 1_000;
    const state = stateAt("down", () => now);
    state.to("idle");
    now = 2_000;
    state.noteActivity("transport");
    now = 3_000;
    state.to("down");
    expect(state.startedAt).toBeUndefined();
    expect(state.clock).toEqual({
      lastActivityAt: 2_000,
      lastActivity: "transport",
      signals: { session: 1_000, transport: 2_000 },
    });
  });

  test("an identity transition is not news — the clock does not move", () => {
    let now = 1_000;
    const state = stateAt("idle", () => now);
    state.noteActivity("transport");
    now = 5_000;
    state.to("idle"); // a reconcile that found nothing (FR-93)
    expect(state.clock.lastActivityAt).toBe(1_000);
  });

  test("stamps are monotone per source — a late observation never rewinds the clock", () => {
    const state = new AgentState("idle");
    state.noteActivity("tokens", 5_000);
    state.noteActivity("tokens", 1_000); // an out-of-order sample
    expect(state.clock.signals.tokens).toBe(5_000);
    state.noteActivity("tokens", Number.NaN);
    expect(state.clock.signals.tokens).toBe(5_000);
  });

  test("lastActivity names the NEWEST source, with every stamp kept in the breakdown", () => {
    const state = new AgentState("idle");
    state.noteActivity("transport", 1_000);
    state.noteActivity("turn", 4_000);
    state.noteActivity("tokens", 9_000);
    expect(state.clock).toMatchObject({ lastActivityAt: 9_000, lastActivity: "tokens" });
    expect(state.clock.signals).toEqual({ transport: 1_000, turn: 4_000, tokens: 9_000 });
  });

  test("clockView derives durations and carries the observation floor", () => {
    const state = new AgentState("idle");
    state.markStarted(1_000);
    state.noteActivity("transport", 6_000);
    expect(clockView(state, 500, 10_000)).toEqual({
      startedAt: 1_000,
      uptimeMs: 9_000,
      lastActivityAt: 6_000,
      lastActivity: "transport",
      quietForMs: 4_000,
      signals: { transport: 6_000 },
      observedSince: 500,
    });
  });

  test("clockView of an unwitnessed agent reports the floor and nothing else", () => {
    // "Quiet since forever" and "we only started watching a minute ago" must not
    // read the same: a zero here would claim the first (§10.34).
    expect(clockView(new AgentState("idle"), 500, 10_000)).toEqual({
      signals: {},
      observedSince: 500,
    });
  });
});
