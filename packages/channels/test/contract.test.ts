import { describe, expect, test } from "bun:test";
import { RouteRefusedError, normalizePayload, operatorErrorText } from "../src/contract";

describe("payload convention (§5.3)", () => {
  test("a plain string is text", () => {
    expect(normalizePayload("hi")).toEqual({ text: "hi", blobs: [] });
  });

  test("text + blob refs pass through; string refs are accepted", () => {
    expect(
      normalizePayload({ text: "see files", blobs: ["abc", { blob: "def", name: "a.txt" }] }),
    ).toEqual({ text: "see files", blobs: [{ blob: "abc" }, { blob: "def", name: "a.txt" }] });
  });

  test("malformed blob refs are dropped — untrusted edge input (§8.7)", () => {
    expect(normalizePayload({ blobs: [42, { path: "/etc/passwd" }, { blob: "ok" }] })).toEqual({
      blobs: [{ blob: "ok" }],
    });
  });

  test("anything else is rendered as JSON text so the operator still sees it", () => {
    expect(normalizePayload({ task: "review", priority: 1 })).toEqual({
      text: '{"task":"review","priority":1}',
      blobs: [],
    });
  });
});

describe("operator-facing errors (§3.2, §8.7)", () => {
  test("route refusals are explained", () => {
    expect(operatorErrorText(new RouteRefusedError("TOPOLOGY_DENIED", "writer"))).toContain(
      'cannot deliver to "writer"',
    );
    expect(operatorErrorText(new RouteRefusedError("UNKNOWN_PEER", "ghost"))).toContain(
      'unknown peer "ghost"',
    );
  });

  test("everything else is generic — internals never leak", () => {
    expect(operatorErrorText(new Error("ENOENT /config_dir/queue/op/cur"))).toBe(
      "muxeon: delivery failed",
    );
  });
});
