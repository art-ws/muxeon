import { describe, expect, test } from "bun:test";
import { SESSION_ACTIONS, SessionGrants, isSessionAction } from "../src/session-grants";

// The directed agent→agent session-control ACL with "*" wildcards (FR-96/FR-97, §7.1).
describe("SessionGrants (FR-96/FR-97)", () => {
  test("the closed action set is the five lifecycle verbs", () => {
    expect([...SESSION_ACTIONS]).toEqual(["start", "stop", "shutdown", "restart", "reload"]);
    expect(isSessionAction("restart")).toBe(true);
    expect(isSessionAction("nope")).toBe(false);
  });

  test("an empty map grants nothing", () => {
    const grants = new SessionGrants();
    expect(grants.allowedFor("a", "b")).toEqual(new Set());
    expect(grants.permits("a", "b", "restart")).toBe(false);
  });

  test("an explicit grant is the union of its actions, and only its actions", () => {
    const grants = new SessionGrants({ a: { b: ["restart", "stop"] } });
    expect(grants.allowedFor("a", "b")).toEqual(new Set(["restart", "stop"]));
    expect(grants.permits("a", "b", "restart")).toBe(true);
    expect(grants.permits("a", "b", "start")).toBe(false);
    // direction matters — b→a is not implied
    expect(grants.permits("b", "a", "restart")).toBe(false);
    // a different recipient is not implied
    expect(grants.permits("a", "c", "restart")).toBe(false);
  });

  test('"*" as an action element means every action (allowedFor → "all")', () => {
    const grants = new SessionGrants({ a: { b: ["*"] } });
    expect(grants.allowedFor("a", "b")).toBe("all");
    expect(grants.permits("a", "b", "shutdown")).toBe(true);
  });

  test('"*" recipient grants apply to any recipient', () => {
    const grants = new SessionGrants({ a: { "*": ["reload"] } });
    expect(grants.permits("a", "b", "reload")).toBe(true);
    expect(grants.permits("a", "zzz", "reload")).toBe(true);
    expect(grants.permits("a", "b", "stop")).toBe(false);
  });

  test('"*" sender grants apply to any sender', () => {
    const grants = new SessionGrants({ "*": { b: ["stop"] } });
    expect(grants.permits("a", "b", "stop")).toBe(true);
    expect(grants.permits("zzz", "b", "stop")).toBe(true);
    expect(grants.permits("a", "c", "stop")).toBe(false);
  });

  test("the four matching cells union together (from→to, from→*, *→to, *→*)", () => {
    const grants = new SessionGrants({
      a: { b: ["start"], "*": ["stop"] },
      "*": { b: ["restart"], "*": ["reload"] },
    });
    expect(grants.allowedFor("a", "b")).toEqual(new Set(["start", "stop", "restart", "reload"]));
    // a sender/recipient with no explicit cells still gets the *→* grant
    expect(grants.allowedFor("x", "y")).toEqual(new Set(["reload"]));
  });

  test('a "*" in any matching cell short-circuits to "all"', () => {
    const grants = new SessionGrants({ a: { b: ["start"] }, "*": { "*": ["*"] } });
    expect(grants.allowedFor("a", "b")).toBe("all");
    expect(grants.permits("someone", "anyone", "restart")).toBe(true);
  });

  // The exact parallel of CommandGrants.permitsSelf (§21/§10.33): restarting
  // yourself takes an explicit self cell, never a recipient wildcard.
  describe("permitting one's OWN session (§21)", () => {
    test('a "*" recipient does NOT reach the sender itself', () => {
      const grants = new SessionGrants({ tl: { "*": ["restart"] } });
      expect(grants.permits("tl", "dev", "restart")).toBe(true);
      expect(grants.permitsSelf("tl", "restart")).toBe(false);
    });

    test('an explicit self cell does, and its own "*" means every action', () => {
      expect(new SessionGrants({ dev: { dev: ["restart"] } }).permitsSelf("dev", "restart")).toBe(
        true,
      );
      expect(new SessionGrants({ dev: { dev: ["restart"] } }).permitsSelf("dev", "stop")).toBe(
        false,
      );
      expect(new SessionGrants({ dev: { dev: ["*"] } }).permitsSelf("dev", "shutdown")).toBe(true);
    });
  });
});
