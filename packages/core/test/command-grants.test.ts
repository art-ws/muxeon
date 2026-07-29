import { describe, expect, test } from "bun:test";
import { CommandGrants } from "../src/command-grants";

// The directed agent→agent command ACL with "*" wildcards (FR-94/FR-95, §7.1).
describe("CommandGrants (FR-94/FR-95)", () => {
  test("an empty map grants nothing", () => {
    const grants = new CommandGrants();
    expect(grants.allowedFor("a", "b")).toEqual(new Set());
    expect(grants.permits("a", "b", "clear")).toBe(false);
  });

  test("an explicit grant is the union of its slashes, and only its slashes", () => {
    const grants = new CommandGrants({ a: { b: ["clear", "compact"] } });
    expect(grants.allowedFor("a", "b")).toEqual(new Set(["clear", "compact"]));
    expect(grants.permits("a", "b", "clear")).toBe(true);
    expect(grants.permits("a", "b", "usage")).toBe(false);
    // direction matters — b→a is not implied
    expect(grants.permits("b", "a", "clear")).toBe(false);
    // a different recipient is not implied
    expect(grants.permits("a", "c", "clear")).toBe(false);
  });

  test('"*" as a command element means every command (allowedFor → "all")', () => {
    const grants = new CommandGrants({ a: { b: ["*"] } });
    expect(grants.allowedFor("a", "b")).toBe("all");
    expect(grants.permits("a", "b", "anything")).toBe(true);
  });

  test('"*" recipient grants apply to any recipient', () => {
    const grants = new CommandGrants({ a: { "*": ["clear"] } });
    expect(grants.permits("a", "b", "clear")).toBe(true);
    expect(grants.permits("a", "zzz", "clear")).toBe(true);
    expect(grants.permits("a", "b", "compact")).toBe(false);
  });

  test('"*" sender grants apply to any sender', () => {
    const grants = new CommandGrants({ "*": { b: ["clear"] } });
    expect(grants.permits("a", "b", "clear")).toBe(true);
    expect(grants.permits("zzz", "b", "clear")).toBe(true);
    expect(grants.permits("a", "c", "clear")).toBe(false);
  });

  test("the four matching cells union together (from→to, from→*, *→to, *→*)", () => {
    const grants = new CommandGrants({
      a: { b: ["clear"], "*": ["compact"] },
      "*": { b: ["usage"], "*": ["screenshot"] },
    });
    expect(grants.allowedFor("a", "b")).toEqual(
      new Set(["clear", "compact", "usage", "screenshot"]),
    );
    // a sender/recipient with no explicit cells still gets the *→* grant
    expect(grants.allowedFor("x", "y")).toEqual(new Set(["screenshot"]));
  });

  test('a "*" in any matching cell short-circuits to "all"', () => {
    const grants = new CommandGrants({ a: { b: ["clear"] }, "*": { "*": ["*"] } });
    expect(grants.allowedFor("a", "b")).toBe("all");
    expect(grants.permits("someone", "anyone", "whatever")).toBe(true);
  });
});
