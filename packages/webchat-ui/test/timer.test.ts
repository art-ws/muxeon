// The "thinking…" elapsed formatter (T84, FR-63): seconds → m:ss → h:mm:ss.

import { describe, expect, test } from "bun:test";
import { formatElapsed } from "../src/Chat";

describe("formatElapsed (FR-63)", () => {
  test.each<[number, string]>([
    [0, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59_000, "59s"],
    [60_000, "1:00"],
    [89_000, "1:29"],
    [3_599_000, "59:59"],
    [3_600_000, "1:00:00"],
    [3_661_000, "1:01:01"],
    [-5000, "0s"], // a clock skew never renders negative
  ])("%p ms → %p", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});
