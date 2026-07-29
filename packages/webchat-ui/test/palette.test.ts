// Agent colors (T99, FR-73) — the pure palette logic: a stable pick from the
// name, the configured color winning, hue separation in the palette. DOM-free.

import { describe, expect, test } from "bun:test";
import { AGENT_PALETTE, agentColor, hashName } from "../src/palette";

describe("agentColor (FR-73)", () => {
  test("deterministic: the same name always gets the same color", () => {
    expect(agentColor("sherlock")).toBe(agentColor("sherlock"));
    expect(agentColor("devops")).toBe(agentColor("devops"));
  });

  test("the pick comes from the palette", () => {
    for (const name of ["aims", "ceo", "cto", "dev", "devops", "sherlock", "teamai"]) {
      expect(AGENT_PALETTE).toContain(agentColor(name));
    }
  });

  test("a configured color wins over the palette", () => {
    expect(agentColor("sherlock", "#ff8800")).toBe("#ff8800");
    expect(agentColor("sherlock", "")).toBe(agentColor("sherlock")); // junk-empty falls back
  });

  test("different names spread across the palette (not all one bucket)", () => {
    const names = ["aims", "ceo", "cto", "dev", "devops", "sherlock", "teamai", "test", "tl"];
    const distinct = new Set(names.map((name) => agentColor(name)));
    expect(distinct.size).toBeGreaterThan(names.length / 2);
  });
});

describe("palette geometry (FR-73)", () => {
  test("12 entries, all distinct", () => {
    expect(AGENT_PALETTE.length).toBe(12);
    expect(new Set(AGENT_PALETTE).size).toBe(AGENT_PALETTE.length);
  });

  test("hues are well separated (≥20° apart pairwise)", () => {
    const hues = AGENT_PALETTE.map((color) => {
      const match = /^hsl\((\d+) /.exec(color);
      expect(match).not.toBeNull();
      return Number(match?.[1]);
    }).sort((a, b) => a - b);
    for (let i = 1; i < hues.length; i++) {
      expect((hues[i] as number) - (hues[i - 1] as number)).toBeGreaterThanOrEqual(20);
    }
    // the wrap-around gap too (last → first + 360)
    expect((hues[0] as number) + 360 - (hues[hues.length - 1] as number)).toBeGreaterThanOrEqual(
      20,
    );
  });
});

describe("hashName", () => {
  test("stable and 32-bit unsigned", () => {
    expect(hashName("sherlock")).toBe(hashName("sherlock"));
    expect(hashName("a")).toBeGreaterThanOrEqual(0);
    expect(hashName("a")).toBeLessThanOrEqual(0xffffffff);
    expect(hashName("a")).not.toBe(hashName("b"));
  });
});
