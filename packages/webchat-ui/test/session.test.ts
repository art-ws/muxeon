// Session auto-renewal policy (T125, FR-86) — the pure half.

import { describe, expect, test } from "bun:test";
import { renewDueAt } from "../src/session";

describe("renewDueAt (FR-86)", () => {
  test("fires at the half-life of the known window", () => {
    expect(renewDueAt(1000, 11_000)).toBe(6_000);
  });

  test("an already-expired reading renews immediately, not in the past loop", () => {
    expect(renewDueAt(5_000, 3_000)).toBe(5_000); // clamped — never before learnedAt
  });
});
