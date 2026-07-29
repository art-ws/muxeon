import { describe, expect, test } from "bun:test";
import { resolveTarget } from "../src/address";

const agents = new Set(["researcher", "writer"]);

describe("inbound addressing (§3.2)", () => {
  test("the first left-to-right @token matching a known agent wins", () => {
    expect(resolveTarget("@writer please sync with @researcher", agents)).toEqual({
      ok: true,
      target: "writer",
    });
  });

  test("an @token matching nothing is plain text — defaultTarget applies", () => {
    expect(resolveTarget("ping @everyone about the launch", agents, "researcher")).toEqual({
      ok: true,
      target: "researcher",
    });
  });

  test("a non-matching token is skipped in favor of a later matching one", () => {
    expect(resolveTarget("@everyone hey @writer", agents)).toEqual({ ok: true, target: "writer" });
  });

  test("no @token and a defaultTarget → defaultTarget", () => {
    expect(resolveTarget("just text", agents, "researcher")).toEqual({
      ok: true,
      target: "researcher",
    });
  });

  test("no @token and no defaultTarget → NO_TARGET (§3.2 error to the operator)", () => {
    expect(resolveTarget("just text", agents)).toEqual({ ok: false, reason: "NO_TARGET" });
    expect(resolveTarget(undefined, agents)).toEqual({ ok: false, reason: "NO_TARGET" });
  });

  test("the matched token must be the exact agent name", () => {
    expect(resolveTarget("@writers room", agents, "researcher")).toEqual({
      ok: true,
      target: "researcher", // "writers" ≠ "writer" → plain text
    });
  });
});
