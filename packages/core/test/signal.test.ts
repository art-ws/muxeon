import { describe, expect, test } from "bun:test";
import { type Signal, isNotificationOnly } from "../src/signal";

// The notice predicate (§13.7, §19.6) — the rule four layers must agree on: the
// render (which must name no reply path), the exchange (which must create no
// folder for an answer nobody wants), the nudger (which must not scrape a
// receiver that owes nothing) and the rendezvous coordinator (which must not
// resurrect a refused notice). One line: the flag when set, else the kind's default.
describe("isNotificationOnly (§13.7/§19.6)", () => {
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

  test("a message asks by default — every kind but reaction does", () => {
    for (const kind of ["message", "nudge", "rendezvous", "broadcast"] as const) {
      expect(isNotificationOnly({ ...base, kind })).toBe(false);
      expect(isNotificationOnly({ ...base, kind, expectsReply: true })).toBe(false);
    }
  });

  // FR-180: the receipt. Without it there is no free "принято" between agents —
  // kind:"ack" is rejected (the kind set is closed) and the injected contract asks
  // for an answer even when the text says not to.
  test("expectsReply:false makes a message a notice", () => {
    expect(isNotificationOnly({ ...base, kind: "message", expectsReply: false })).toBe(true);
  });

  test("the flag beats the kind's default in both directions", () => {
    // Same envelope, opposite kinds, opposite defaults — the flag decides alone.
    expect(isNotificationOnly({ ...base, kind: "message", expectsReply: false })).toBe(true);
    expect(isNotificationOnly({ ...base, kind: "reaction", expectsReply: true })).toBe(false);
  });
});
