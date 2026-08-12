// §18.1/§18.4 (decision §18.10-8): email-style FQN — chains grow right, resolve
// by the LAST separator; degenerate forms are unroutable, not local.

import { describe, expect, test } from "bun:test";
import { appendServer, isFqn, splitFqn } from "../src";

describe("FQN (§18.4)", () => {
  test("isFqn detects the separator", () => {
    expect(isFqn("dev")).toBe(false);
    expect(isFqn("dev@hq")).toBe(true);
    expect(isFqn("bob@c@b")).toBe(true);
  });

  test("splitFqn resolves by the LAST @ — the head stays opaque", () => {
    expect(splitFqn("alex@muxeon1")).toEqual({ head: "alex", tail: "muxeon1" });
    expect(splitFqn("bob@c@b")).toEqual({ head: "bob@c", tail: "b" });
  });

  test("local and degenerate names do not split", () => {
    expect(splitFqn("dev")).toBeNull();
    expect(splitFqn("@hq")).toBeNull();
    expect(splitFqn("dev@")).toBeNull();
    expect(splitFqn("@")).toBeNull();
  });

  test("appendServer is the re-export rule (§18.4)", () => {
    expect(appendServer("dev", "b")).toBe("dev@b");
    expect(appendServer("dev@c", "b")).toBe("dev@c@b");
    // A suffixed name round-trips through splitFqn.
    expect(splitFqn(appendServer("dev@c", "b"))).toEqual({ head: "dev@c", tail: "b" });
  });
});
