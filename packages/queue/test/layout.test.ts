import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertSafeFileId, isSafeFileId, queuePaths, sanitizeFileId } from "../src/layout";

describe("queue names + paths safety (§5.3, §8.7)", () => {
  test("queuePaths rejects unsafe session names", () => {
    expect(() => queuePaths("/root", "../escape")).toThrow();
    expect(() => queuePaths("/root", "a/b")).toThrow();
    expect(() => queuePaths("/root", "")).toThrow();
    expect(() => queuePaths("/root", "..")).toThrow();
  });

  test("queuePaths builds the maildir layout under <root>/<session>", () => {
    const paths = queuePaths("/root", "sess");
    expect(paths.dir).toBe(join("/root", "sess"));
    expect(paths.pending).toBe(join("/root", "sess", "pending"));
    expect(paths.cur).toBe(join("/root", "sess", "cur"));
  });

  test("isSafeFileId enforces the §8.7 charset and length bound", () => {
    expect(isSafeFileId("abc-DEF_123")).toBe(true);
    expect(isSafeFileId("")).toBe(false);
    expect(isSafeFileId("../x")).toBe(false);
    expect(isSafeFileId("a/b")).toBe(false);
    expect(isSafeFileId("a.b")).toBe(false);
    expect(isSafeFileId("x".repeat(201))).toBe(false);
  });

  test("sanitizeFileId yields a safe id and never empties", () => {
    expect(isSafeFileId(sanitizeFileId("550e8400-e29b-41d4-a716-446655440000"))).toBe(true);
    expect(sanitizeFileId("../../etc/passwd")).not.toContain("/");
    expect(sanitizeFileId("///")).not.toBe("");
    expect(isSafeFileId(sanitizeFileId("emoji-🚀-and/slash"))).toBe(true);
    expect(() => assertSafeFileId(sanitizeFileId("anything at all !@#"))).not.toThrow();
  });
});
