import { describe, expect, test } from "bun:test";
import { type AgentStatus, type Message, type Signal, isMessage } from "../src/index";

describe("domain envelopes (§2, §5.1, §5.3)", () => {
  test("a Message is a message-kind Signal; optional fields may be omitted", () => {
    const msg: Message = {
      id: "abc-123",
      from: "researcher",
      to: "writer",
      kind: "message",
      ts: 1700000000000,
      payload: { text: "hello" },
    };
    expect(isMessage(msg)).toBe(true);
    expect(msg.replyTo).toBeUndefined();
    expect(msg.origin).toBeUndefined();
  });

  test("isMessage narrows a Signal by kind", () => {
    const signal: Signal = {
      id: "s1",
      from: "a",
      to: "b",
      kind: "message",
      ts: 0,
      payload: null,
    };
    expect(isMessage(signal)).toBe(true);
  });

  test("AgentStatus covers idle/busy/down (§5.1)", () => {
    const all: AgentStatus[] = ["idle", "busy", "down"];
    expect(all).toContain("busy");
  });
});
