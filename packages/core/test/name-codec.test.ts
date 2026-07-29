import { describe, expect, test } from "bun:test";
import {
  type QueueName,
  compareQueueNames,
  formatQueueName,
  parseQueueName,
} from "../src/name-codec";

const CASES: QueueName[] = [
  { unixMs: 1, seq: 0, id: "a" },
  { unixMs: 1700000000000, seq: 42, id: "550e8400-e29b-41d4-a716-446655440000" }, // UUID w/ dashes
  { unixMs: 0, seq: 0, id: "x" },
  { unixMs: 1700000000001, seq: 7, id: "has-many-internal-dashes" },
  { unixMs: 1700000000002, seq: 100000, id: "id.with.dots" },
  { unixMs: 1700000000003, seq: 3, id: "a.json" }, // id that itself ends in .json
  { unixMs: Number.MAX_SAFE_INTEGER, seq: 1, id: "max-safe-ts" },
];

describe("queue name codec (§5.3, FR-17)", () => {
  test("format → parse round-trips unixMs, seq, id", () => {
    for (const original of CASES) {
      expect(parseQueueName(formatQueueName(original))).toEqual(original);
    }
  });

  test("format produces <unix_ms>-<seq>-<id>.json", () => {
    expect(formatQueueName({ unixMs: 12, seq: 3, id: "abc" })).toBe("12-3-abc.json");
  });

  test("id may contain dashes — positional parse keeps the remainder", () => {
    expect(parseQueueName("1700000000000-5-a-b-c.json")).toEqual({
      unixMs: 1700000000000,
      seq: 5,
      id: "a-b-c",
    });
  });

  test("parse rejects malformed names", () => {
    expect(() => parseQueueName("nope.json")).toThrow(); // no fields
    expect(() => parseQueueName("12-3-abc.txt")).toThrow(); // wrong suffix
    expect(() => parseQueueName("-3-id.json")).toThrow(); // empty unix_ms
    expect(() => parseQueueName("12--id.json")).toThrow(); // empty seq
    expect(() => parseQueueName("12-3-.json")).toThrow(); // empty id
    expect(() => parseQueueName("12-x-id.json")).toThrow(); // non-numeric seq
    expect(() => parseQueueName("1.5-3-id.json")).toThrow(); // non-integer unix_ms
  });

  test("format rejects negative / non-integer / empty id", () => {
    expect(() => formatQueueName({ unixMs: -1, seq: 0, id: "a" })).toThrow();
    expect(() => formatQueueName({ unixMs: 1.5, seq: 0, id: "a" })).toThrow();
    expect(() => formatQueueName({ unixMs: 1, seq: -1, id: "a" })).toThrow();
    expect(() => formatQueueName({ unixMs: 1, seq: 0, id: "" })).toThrow();
  });

  test("ordering is unix_ms → seq → id, numerically (not lexically)", () => {
    const seq9: QueueName = { unixMs: 1000, seq: 9, id: "z" };
    const seq10: QueueName = { unixMs: 1000, seq: 10, id: "a" };
    // Lexically "10" < "9", but seq 9 must order before seq 10:
    expect(compareQueueNames(seq9, seq10)).toBeLessThan(0);
    expect(compareQueueNames(seq10, seq9)).toBeGreaterThan(0);
    expect(compareQueueNames(seq9, seq9)).toBe(0);

    const unsorted: QueueName[] = [
      { unixMs: 2, seq: 0, id: "a" },
      { unixMs: 1, seq: 5, id: "b" },
      { unixMs: 1, seq: 5, id: "a" },
      { unixMs: 1, seq: 2, id: "z" },
    ];
    expect([...unsorted].sort(compareQueueNames)).toEqual([
      { unixMs: 1, seq: 2, id: "z" },
      { unixMs: 1, seq: 5, id: "a" },
      { unixMs: 1, seq: 5, id: "b" },
      { unixMs: 2, seq: 0, id: "a" },
    ]);
  });
});
