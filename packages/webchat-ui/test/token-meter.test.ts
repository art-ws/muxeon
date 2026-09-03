import { describe, expect, test } from "bun:test";
import {
  SLOT_W,
  fmtPercent,
  fmtTokens,
  healthColor,
  healthRatio,
  layoutHistogram,
  orbText,
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

describe("histogram layout — fixed 5px time grid (§12.8, FR-103; T344)", () => {
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
  /** A box wide enough for everything: 24 hourly + 60 minute columns and then some. */
  const WIDE = 1000;
  const lay = (s: TokenSeries, box = WIDE, now = T0): ReturnType<typeof layoutHistogram> =>
    layoutHistogram(s, box, 20, now);

  test("empty when there are no columns, no width, or no height", () => {
    const none: TokenSeries = {
      minutes: [],
      hours: [],
      current: 0,
      updatedAt: 0,
      maxThreshold: 1000,
    };
    expect(lay(none).bars).toEqual([]);
    expect(lay(series, 0).bars).toEqual([]);
    expect(lay(series, 4).bars).toEqual([]); // less than one whole column fits
    expect(layoutHistogram(series, WIDE, 0, T0).bars).toEqual([]);
  });

  test("EVERY column is exactly SLOT_W wide — never wider, in either zone", () => {
    expect(SLOT_W).toBeLessThanOrEqual(5);
    for (const b of lay(series).bars) expect(b.w).toBe(SLOT_W);
    // and the same holds when the data is dense (a bucket in every minute slot)
    const dense: TokenSeries = {
      ...series,
      minutes: Array.from({ length: 60 }, (_, i) => ({ t: T0 - (60 - i) * M, tokens: 100 + i })),
    };
    for (const b of lay(dense).bars) expect(b.w).toBe(SLOT_W);
  });

  test("a silent interval leaves a gap of exactly one slot — columns sit on TIME", () => {
    // three samples 1 minute apart, then a 4-minute silence, then one more
    const gapped: TokenSeries = {
      hours: [],
      minutes: [
        { t: T0 - 10 * M, tokens: 100 },
        { t: T0 - 9 * M, tokens: 200 },
        { t: T0 - 4 * M, tokens: 300 },
      ],
      current: 300,
      updatedAt: T0 - 4 * M,
      maxThreshold: 1000,
    };
    const xs = lay(gapped).bars.map((b) => b.x);
    expect(xs[1] - (xs[0] ?? 0)).toBe(SLOT_W); // adjacent minutes: one slot apart
    expect((xs[2] ?? 0) - (xs[1] ?? 0)).toBe(5 * SLOT_W); // five minutes: five slots
  });

  test("the per-minute zone keeps ONE width whatever the data — the whole minuteSpan", () => {
    const wide = lay(series);
    expect(wide.minutesW).toBe(60 * SLOT_W); // 60m default, 3 sampled minutes
    const oneSample = lay({ ...series, minutes: [{ t: T0 - 1 * M, tokens: 500 }] });
    expect(oneSample.minutesW).toBe(60 * SLOT_W); // same width, one column drawn
    expect(oneSample.bars.filter((b) => b.zone === "minute")).toHaveLength(1);
    // a type configured with a shallower span gets a narrower — but still fixed — zone
    expect(lay({ ...series, minuteSpanMs: 30 * M }).minutesW).toBe(30 * SLOT_W);
  });

  test("the grid ends at the CURRENT minute — the right edge is now, not the last sample", () => {
    // `now` is T0 and the newest sample is a minute old, so the rightmost slot is the
    // running minute, still empty: the newest column stops one slot short of the edge.
    const l = lay(series);
    const newest = l.bars.filter((b) => b.zone === "minute").at(-1);
    expect(newest?.t).toBe(T0 - 1 * M);
    expect((newest?.x ?? 0) + SLOT_W).toBe(l.width - SLOT_W);
    // once the running minute is sampled, its column IS flush against the orb side
    const fresh = lay({ ...series, minutes: [...series.minutes, { t: T0, tokens: 530 }] });
    expect((fresh.bars.at(-1)?.x ?? 0) + SLOT_W).toBe(fresh.width);
  });

  test("the hourly zone spans the hourly history and drops its OLDEST columns first", () => {
    const many: TokenSeries = {
      ...series,
      hours: Array.from({ length: 24 }, (_, i) => ({
        t: T0 - (24 - i) * H,
        tokens: 1000 + i * 10,
      })),
    };
    const wide = lay(many);
    expect(wide.hoursW).toBe(24 * SLOT_W); // everything fits: 24h + 60m == 420px
    expect(wide.width).toBe((24 + 60) * SLOT_W);
    expect(wide.droppedHours).toBe(0);

    // a box with room for 70 columns: the 60 minute slots hold, 10 hours survive
    const narrow = lay(many, 70 * SLOT_W);
    expect(narrow.minutesW).toBe(60 * SLOT_W);
    expect(narrow.hoursW).toBe(10 * SLOT_W);
    expect(narrow.droppedHours).toBe(14);
    const hours = narrow.bars.filter((b) => b.zone === "hour");
    expect(hours[0]?.t).toBe(T0 - 10 * H); // the ten NEWEST hours, oldest cut away
    expect(hours.at(-1)?.t).toBe(T0 - 1 * H);
    expect(hours[0]?.x).toBe(0);
  });

  test("a box too narrow even for the minute zone trims the minutes the same way", () => {
    const l = lay(series, 3 * SLOT_W);
    expect(l.width).toBe(3 * SLOT_W);
    expect(l.hoursW).toBe(0); // no room left for history at all
    // three slots ending at the running (unsampled) minute ⇒ the two newest samples
    expect(l.bars.map((b) => b.t)).toEqual([T0 - 2 * M, T0 - 1 * M]);
    expect(l.bars.map((b) => b.x)).toEqual([0, SLOT_W]);
  });

  test("nothing is ever drawn outside the box", () => {
    for (const box of [7, 33, 120, 421, 1000]) {
      const l = lay(
        {
          ...series,
          hours: Array.from({ length: 24 }, (_, i) => ({ t: T0 - (24 - i) * H, tokens: i })),
        },
        box,
      );
      expect(l.width).toBeLessThanOrEqual(box);
      for (const b of l.bars) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(l.width);
      }
    }
  });

  test("bar HEIGHT is spend (Δ level within a resolution), clamped ≥0", () => {
    const bars = lay(series).bars;
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

  test("spend skips OVER a gap to the last level actually sampled", () => {
    const gapped: TokenSeries = {
      hours: [],
      minutes: [
        { t: T0 - 9 * M, tokens: 100 },
        { t: T0 - 4 * M, tokens: 400 }, // five minutes of silence, then +300
      ],
      current: 400,
      updatedAt: T0 - 4 * M,
      maxThreshold: 1000,
    };
    expect(lay(gapped).bars.map((b) => b.spend)).toEqual([0, 300]);
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
    const bars = lay(s).bars;
    const hourMax = Math.max(...bars.filter((b) => b.zone === "hour").map((b) => b.h));
    const minuteMax = Math.max(...bars.filter((b) => b.zone === "minute").map((b) => b.h));
    expect(hourMax).toBeCloseTo(20, 5);
    expect(minuteMax).toBeCloseTo(20, 5);
  });

  test("the height scale follows the VISIBLE columns — a cut-off spike can't flatten them", () => {
    // the oldest hour holds a huge spike; once it is scrolled out, the rest scales up
    const s: TokenSeries = {
      hours: [
        { t: T0 - 4 * H, tokens: 0 },
        { t: T0 - 3 * H, tokens: 900_000 }, // the monster
        { t: T0 - 2 * H, tokens: 900_100 },
        { t: T0 - 1 * H, tokens: 900_200 },
      ],
      minutes: [],
      current: 900_200,
      updatedAt: T0 - 1 * H,
      maxThreshold: 1_000_000,
    };
    const tall = lay(s, (60 + 2) * SLOT_W).bars.filter((b) => b.zone === "hour");
    expect(tall.map((b) => b.t)).toEqual([T0 - 2 * H, T0 - 1 * H]); // monster dropped
    expect(Math.max(...tall.map((b) => b.h))).toBeCloseTo(20, 5); // and the rest breathes
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
    const bars = lay(s).bars;
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
    expect(lay(s).bars[1]?.color).toBe(healthColor(1));
  });

  test("the minute grid is anchored on the LATEST of clock and data (skew-proof)", () => {
    // a browser running 10 minutes behind the server must not drop the newest column
    const l = lay(series, WIDE, T0 - 10 * M);
    expect(l.bars.filter((b) => b.zone === "minute").at(-1)?.t).toBe(T0 - 1 * M);
    // and one running ahead simply shows empty slots on the right
    const ahead = lay(series, WIDE, T0 + 10 * M);
    const newest = ahead.bars.filter((b) => b.zone === "minute").at(-1);
    expect(newest?.t).toBe(T0 - 1 * M);
    expect((newest?.x ?? 0) + SLOT_W).toBe(ahead.width - 11 * SLOT_W); // 10m skew + the running minute
  });

  test("minutes older than the span fall off the grid instead of piling up at the edge", () => {
    const stale: TokenSeries = {
      ...series,
      minutes: [{ t: T0 - 200 * M, tokens: 10 }, ...series.minutes],
    };
    expect(
      lay(stale)
        .bars.filter((b) => b.zone === "minute")
        .map((b) => b.t),
    ).toEqual([T0 - 3 * M, T0 - 2 * M, T0 - 1 * M]);
  });
});

// ── T266: the header shows the percentage; the count moved into the tooltip ──

describe("orb caption vs tooltip (§12.8, FR-103)", () => {
  test("caption is the percentage ALONE — no token count on the header", () => {
    const { label } = orbText(226_813, 1_000_000, "tok");
    expect(label).toBe("23%");
    expect(label).not.toContain("tok");
    expect(label).not.toMatch(/\d{4}/); // no long number competing for the header's width
  });

  test("the tooltip carries the exact count AND the ceiling it is a percentage of", () => {
    const { title } = orbText(226_813, 1_000_000, "tok");
    expect(title).toBe("226\u2009813 tok / 1\u2009000\u2009000 (23%)");
  });

  test("no usable ceiling ⇒ the count itself, never a meaningless 0%", () => {
    for (const ceiling of [0, -1]) {
      const { label, title } = orbText(1234, ceiling, "tok");
      expect(label).toBe("1\u2009234 tok");
      expect(title).toBe("1\u2009234 tok");
      expect(label).not.toContain("%");
    }
  });

  test("percentage is rounded and pins at 100% over the ceiling", () => {
    expect(orbText(0, 1000, "tok").label).toBe("0%");
    expect(orbText(504, 1000, "tok").label).toBe("50%");
    expect(orbText(1500, 1000, "tok").label).toBe("150%"); // honest: over budget is visible
  });
});
