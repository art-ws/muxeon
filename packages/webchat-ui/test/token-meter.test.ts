import { describe, expect, test } from "bun:test";
import {
  HIST_VBW,
  MINUTE_SLOT_MIN,
  buildBars,
  fmtPercent,
  fmtTokens,
  healthColor,
  healthRatio,
  hourZoneWidth,
} from "../src/token-meter";
import type { TokenSeries } from "../src/types";

const M = 60_000;
const H = 3_600_000;
const T0 = 100 * H;

describe("health colour maths (§12.8, FR-103)", () => {
  test("ratio clamps to [0,1] and guards /0", () => {
    expect(healthRatio(0, 1000)).toBe(0);
    expect(healthRatio(500, 1000)).toBe(0.5);
    expect(healthRatio(2000, 1000)).toBe(1); // over threshold pins at full
    expect(healthRatio(5, 0)).toBe(0);
  });

  test("colour sweeps deep green → amber → red (dark, high-contrast)", () => {
    expect(healthColor(0)).toBe("hsl(140, 95%, 42%)"); // green
    expect(healthColor(0.5)).toBe("hsl(70, 95%, 42%)"); // yellow-green
    expect(healthColor(1)).toBe("hsl(0, 95%, 42%)"); // red
    expect(healthColor(9)).toBe("hsl(0, 95%, 42%)"); // clamps past 1
  });
});

describe("formatting (§12.8, FR-103)", () => {
  test("fmtTokens groups thousands with a thin space", () => {
    const T = "\u2009"; // thin space separator
    expect(fmtTokens(12366)).toBe(`12${T}366`);
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000000)).toBe(`1${T}000${T}000`);
  });

  test("fmtPercent rounds and guards /0", () => {
    expect(fmtPercent(360, 1000)).toBe(36);
    expect(fmtPercent(5, 0)).toBe(0);
  });
});

describe("buildBars (§12.8, FR-103)", () => {
  // levels; hour deltas: [0, 150], minute deltas: [0, 20, 0 (drop clamped)]
  const series: TokenSeries = {
    hours: [
      { t: T0 - 2 * H, tokens: 100 },
      { t: T0 - 1 * H, tokens: 250 },
    ],
    minutes: [
      { t: T0 - 3 * M, tokens: 500 },
      { t: T0 - 2 * M, tokens: 520 },
      { t: T0 - 1 * M, tokens: 515 },
    ],
    current: 515,
    updatedAt: T0 - 1 * M,
    maxThreshold: 1000,
  };

  test("empty when there are no columns", () => {
    expect(
      buildBars({ minutes: [], hours: [], current: 0, updatedAt: 0, maxThreshold: 1000 }, 20),
    ).toEqual([]);
  });

  test("bar HEIGHT is spend (Δ level within a resolution), clamped ≥0", () => {
    const bars = buildBars(series, 20);
    expect(bars).toHaveLength(5);
    expect(bars.map((b) => b.spend)).toEqual([0, 150, 0, 20, 0]);
    // first-of-resolution has no predecessor spend; a drop (515<520) clamps to 0.
    // each resolution scales to its OWN max, so the busiest hour bar (150) and the
    // busiest minute bar (20) both fill the height — though 20 ≪ 150.
    expect(bars[1]?.h).toBeCloseTo(20, 5);
    expect(bars[1]?.y).toBeCloseTo(0, 5);
    expect(bars[3]?.h).toBeCloseTo(20, 5);
    expect(bars[3]?.y).toBeCloseTo(0, 5);
    // zero-spend columns are invisible (spiky chart)
    expect(bars[0]?.h).toBe(0);
    expect(bars[4]?.h).toBe(0);
  });

  test("hour and minute resolutions scale independently (per-zone max)", () => {
    // hour spend (100000) dwarfs minute spend (60); a shared scale would flatten the
    // minute bar to ~0. Independent maxima put the busiest bar of EACH zone full-height.
    const s: TokenSeries = {
      hours: [
        { t: T0 - 2 * H, tokens: 0 },
        { t: T0 - 1 * H, tokens: 100000 },
      ],
      minutes: [
        { t: T0 - 2 * M, tokens: 500 },
        { t: T0 - 1 * M, tokens: 560 },
      ],
      current: 560,
      updatedAt: T0 - 1 * M,
      maxThreshold: 1_000_000,
    };
    const bars = buildBars(s, 20);
    const hourMax = Math.max(...bars.filter((b) => b.zone === "hour").map((b) => b.h));
    const minuteMax = Math.max(...bars.filter((b) => b.zone === "minute").map((b) => b.h));
    expect(hourMax).toBeCloseTo(20, 5);
    expect(minuteMax).toBeCloseTo(20, 5);
  });

  test("bar COLOUR is the ABSOLUTE level (max in slot) vs maxThreshold, decoupled from height", () => {
    // levels [0,200,300] drive COLOUR; spends [0,200,100] drive HEIGHT — the two decouple.
    const s: TokenSeries = {
      hours: [
        { t: T0 - 3 * H, tokens: 0 },
        { t: T0 - 2 * H, tokens: 200 },
        { t: T0 - 1 * H, tokens: 300 },
      ],
      minutes: [
        { t: T0 - 2 * M, tokens: 40 },
        { t: T0 - 1 * M, tokens: 60 },
      ],
      current: 60,
      updatedAt: T0 - 1 * M,
      maxThreshold: 1000,
    };
    const bars = buildBars(s, 20);
    // colour = healthColor(level / maxThreshold), not the spend
    expect(bars[1]?.color).toBe(healthColor(200 / 1000));
    expect(bars[2]?.color).toBe(healthColor(300 / 1000));
    expect(bars[4]?.color).toBe(healthColor(60 / 1000));
    // decoupled: bar 1 is TALLER (spend 200 > 100) yet GREENER (level 200 < 300)
    expect(bars[1]?.h ?? 0).toBeGreaterThan(bars[2]?.h ?? 0);
    // zone + bucket time still carried for the tooltip
    expect(bars.map((b) => b.zone)).toEqual(["hour", "hour", "hour", "minute", "minute"]);
    expect(bars[4]?.t).toBe(T0 - 1 * M);
  });

  test("a bucket whose level reaches maxThreshold is red (regardless of spend)", () => {
    const s: TokenSeries = {
      hours: [
        { t: T0 - 2 * H, tokens: 500 },
        { t: T0 - 1 * H, tokens: 1000 }, // level 1000 == ceiling → red
      ],
      minutes: [],
      current: 1000,
      updatedAt: T0 - 1 * H,
      maxThreshold: 1000,
    };
    expect(buildBars(s, 20)[1]?.color).toBe(healthColor(1));
  });

  // 2 hours + 3 minutes; minute columns are 1/3 the width of hour columns.
  const slotH = HIST_VBW / (2 + 3 * (1 / 3));
  const slotM = slotH / 3;

  test("minute columns are 3× thinner than hour columns", () => {
    const bars = buildBars(series, 20);
    const hour = bars.find((b) => b.zone === "hour");
    const minute = bars.find((b) => b.zone === "minute");
    expect(slotH / slotM).toBeCloseTo(3, 5);
    // columns now fill the whole slot (flush), so an hour bar is 3× a minute bar
    expect(hour?.w).toBeCloseTo(slotH, 5);
    expect(minute?.w).toBeCloseTo(slotM, 5);
    expect((hour?.w ?? 0) / (minute?.w ?? 1)).toBeCloseTo(3, 5);
  });

  test("columns are centred in their (per-zone) slot and inside the viewBox", () => {
    const bars = buildBars(series, 20);
    const centres = [
      0.5 * slotH,
      1.5 * slotH,
      2 * slotH + 0.5 * slotM,
      2 * slotH + 1.5 * slotM,
      2 * slotH + 2.5 * slotM,
    ];
    for (const [i, b] of bars.entries()) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(HIST_VBW + 1e-9);
      expect(b.x + b.w / 2).toBeCloseTo(centres[i] ?? 0, 5);
    }
    // flush: consecutive same-zone columns share an edge (no gap between them)
    expect((bars[0]?.x ?? 0) + (bars[0]?.w ?? 0)).toBeCloseTo(bars[1]?.x ?? -1, 5); // hours
    expect((bars[2]?.x ?? 0) + (bars[2]?.w ?? 0)).toBeCloseTo(bars[3]?.x ?? -1, 5); // minutes
  });

  test("hourZoneWidth marks the hour/minute boundary (summed hour slots)", () => {
    expect(hourZoneWidth(series)).toBeCloseTo(2 * slotH, 5);
    // all-minutes → no hour region; all-hours → the full width
    expect(hourZoneWidth({ ...series, hours: [] })).toBeCloseTo(0, 5);
    expect(hourZoneWidth({ ...series, minutes: [] })).toBeCloseTo(HIST_VBW, 5);
  });

  test("a minute column never renders thinner than the floor", () => {
    // many hour buckets would crush minute slots below the floor; the floor holds and
    // the columns still fit inside the viewBox ("не тоньше 3px" beats the 3× ratio).
    const crowded: TokenSeries = {
      hours: Array.from({ length: 200 }, (_, i) => ({ t: T0 - (200 - i) * H, tokens: i })),
      minutes: [
        { t: T0 - 2 * M, tokens: 1000 },
        { t: T0 - 1 * M, tokens: 1100 },
      ],
      current: 1100,
      updatedAt: T0 - 1 * M,
      maxThreshold: 5000,
    };
    const bars = buildBars(crowded, 20);
    for (const b of bars.filter((x) => x.zone === "minute")) {
      expect(b.w).toBeGreaterThanOrEqual(MINUTE_SLOT_MIN - 1e-9); // flush ⇒ bar w == slot ≥ floor
    }
    for (const b of bars) expect(b.x + b.w).toBeLessThanOrEqual(HIST_VBW + 1e-6);
  });
});
