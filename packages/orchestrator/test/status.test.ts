import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@muxeon/core";
import { AgentState, canTransition } from "../src/status";

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
