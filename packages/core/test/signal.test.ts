import { describe, expect, test } from "bun:test";
import { type Signal, isNotificationOnly } from "../src/signal";

// A reaction notice (§19.6, FR-164) — the predicate two layers must agree on: the
// render (which must name no reply path) and the exchange (which must create no
// folder for an answer nobody wants).
describe("isNotificationOnly (§19.6)", () => {
  const base: Signal = {
    id: "r1",
    from: "shagin",
    to: "muxeon",
    kind: "reaction",
    ts: 0,
    payload: "👍",
  };

  test("a reaction is a notice by default", () => {
    expect(isNotificationOnly(base)).toBe(true);
  });

  test("expectsReply:true turns it back into an ordinary turn (the operator's opt-in)", () => {
    expect(isNotificationOnly({ ...base, expectsReply: true })).toBe(false);
    // …and false is the default, not a second meaning.
    expect(isNotificationOnly({ ...base, expectsReply: false })).toBe(true);
  });

  test("no other kind is ever a notice — a message always asks", () => {
    for (const kind of ["message", "nudge", "rendezvous", "broadcast"] as const) {
      expect(isNotificationOnly({ ...base, kind })).toBe(false);
      expect(isNotificationOnly({ ...base, kind, expectsReply: true })).toBe(false);
    }
  });
});
