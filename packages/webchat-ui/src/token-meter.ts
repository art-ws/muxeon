// Pure helpers for the header token meter (§12.8, FR-103): the health colour (for
// both the orb and each histogram bar), number formatting, and the bar geometry.
// Kept out of the TSX so bun tests can pin the maths; the component is a thin view.

import type { TokenSeries } from "./types";

/** current / maxThreshold, clamped to [0, 1] (over-threshold pins at full red). */
export function healthRatio(current: number, maxThreshold: number): number {
  if (maxThreshold <= 0) return 0;
  return Math.max(0, Math.min(current / maxThreshold, 1));
}

/**
 * Health colour on a deep green → amber → red gradient by `ratio` (0..1): hue
 * sweeps 140°→0° (through ~60° yellow near the middle), high saturation with a
 * lowish lightness (42%) so the colour reads dark and high-contrast on the panel's
 * pale background — the older 55% was washed out. Drives the orb AND every bar.
 */
export function healthColor(ratio: number): string {
  const r = Math.max(0, Math.min(ratio, 1));
  const hue = Math.round(140 - 140 * r);
  return `hsl(${hue}, 95%, 42%)`;
}

/** "12366" → "12 366" (thin-space thousands groups), for the token label. */
export function fmtTokens(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}

/** current as an integer percentage of the ceiling — the "(36%)" in the label. */
export function fmtPercent(current: number, maxThreshold: number): number {
  if (maxThreshold <= 0) return 0;
  return Math.round((current / maxThreshold) * 100);
}

/** One histogram bar (viewBox units): geometry, health colour, and tooltip data. */
export interface HistBar {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Health colour of the LEVEL at this bucket (value vs ceiling — like the orb). */
  readonly color: string;
  /** Bucket start (unix ms) — for the tooltip. */
  readonly t: number;
  /** Tokens SPENT in this bucket (Δ level vs the previous same-resolution bucket). */
  readonly spend: number;
  /** Which resolution this column belongs to (drives the X-axis colour band). */
  readonly zone: "hour" | "minute";
}

/**
 * Fixed viewBox width the bars are laid out in; the SVG stretches it to the real
 * container width (`preserveAspectRatio="none"`), so NO pixel measurement is needed
 * — the histogram always renders regardless of layout timing.
 */
export const HIST_VBW = 1000;

/**
 * Column widths (viewBox units): a minute column is laid out `MINUTE_SLOT_RATIO` of an
 * hour column's width, so the recent per-minute region reads as a narrower band than
 * the older hourly one; the two zones fill `HIST_VBW` exactly. A minute column never
 * renders thinner than `MINUTE_SLOT_MIN` — when that floor bites (many hour buckets),
 * minutes hold the floor and the hours absorb the remainder, so "not thinner than ~3px"
 * overrides the strict ratio. Horizontal units stretch to the container (the SVG does no
 * pixel measurement by design), so the floor is approximate.
 */
const MINUTE_SLOT_RATIO = 1 / 3;
/** Minute-column slot floor in viewBox units (bar = ½ slot ⇒ ~3px visible). */
export const MINUTE_SLOT_MIN = 6;

function slotWidths(nH: number, nM: number): { slotH: number; slotM: number } {
  const weight = nH + nM * MINUTE_SLOT_RATIO; // hour weight 1, minute weight 1/3
  if (weight <= 0) return { slotH: 0, slotM: 0 };
  let slotH = HIST_VBW / weight;
  let slotM = slotH * MINUTE_SLOT_RATIO;
  if (nM > 0 && slotM < MINUTE_SLOT_MIN) {
    slotM = Math.min(MINUTE_SLOT_MIN, HIST_VBW / nM); // minutes alone can't overflow the width
    slotH = nH > 0 ? Math.max((HIST_VBW - nM * slotM) / nH, 0) : 0;
  }
  return { slotH, slotM };
}

/** Width of the hourly region (== left edge of the per-minute region) — drives the zone wash. */
export function hourZoneWidth(series: TokenSeries): number {
  const { slotH } = slotWidths(series.hours.length, series.minutes.length);
  return series.hours.length * slotH;
}

/**
 * Lay out spend spikes across the viewBox (`HIST_VBW` × `height`), no vertical padding.
 * Each column's HEIGHT is the tokens spent in that bucket — the growth of the level vs
 * the previous bucket of the SAME resolution, clamped ≥0 (a drop from /compact or /clear
 * is not consumption) — scaled to the busiest bucket of its OWN resolution, so hours and
 * minutes normalise independently and the tallest bar in each zone is full-height (an
 * hour's spend dwarfs a minute's; a shared scale would flatten the per-minute bars). Its
 * COLOUR is the green→red health scale applied to the bucket's ABSOLUTE token level —
 * the max sampled in that slot (`tokens / maxThreshold`, same scale as the orb): red means
 * the context was ~full then, INDEPENDENT of the bar's height — a short bar (little spent)
 * can be red if the level was high, and a tall one green if the level was low.
 * Hourly columns (older) sit left of the narrower per-minute columns (recent).
 */
export function buildBars(series: TokenSeries, height: number): readonly HistBar[] {
  const cols = [
    ...series.hours.map((b) => ({ ...b, zone: "hour" as const })),
    ...series.minutes.map((b) => ({ ...b, zone: "minute" as const })),
  ];
  const n = cols.length;
  if (n === 0 || height <= 0) return [];
  const spends = cols.map((c, i) => {
    const prev = cols[i - 1];
    if (prev === undefined || prev.zone !== c.zone) return 0; // first of a resolution
    return Math.max(0, c.tokens - prev.tokens);
  });
  const nH = series.hours.length;
  // Each resolution scales to ITS OWN busiest bucket, not a shared max: an hour
  // accumulates far more than a minute, so one shared scale flattens the per-minute
  // bars to nothing. Independent maxima keep the tallest bar in EACH zone full-height.
  const maxSpendH = Math.max(1, ...spends.slice(0, nH));
  const maxSpendM = Math.max(1, ...spends.slice(nH));
  const { slotH, slotM } = slotWidths(nH, series.minutes.length);
  const hoursW = nH * slotH; // hours fill [0, hoursW); the narrower minutes fill the rest
  return cols.map((c, i) => {
    const slot = c.zone === "hour" ? slotH : slotM;
    const left = c.zone === "hour" ? i * slotH : hoursW + (i - nH) * slotM;
    const spend = spends[i] ?? 0;
    const maxSpend = c.zone === "hour" ? maxSpendH : maxSpendM;
    const h = spend > 0 ? Math.max((spend / maxSpend) * height, 1) : 0;
    const w = slot; // flush columns — each fills its full slot, no gaps between them
    return {
      x: left,
      y: height - h,
      w,
      h,
      color: healthColor(healthRatio(c.tokens, series.maxThreshold)), // absolute level (max in slot) vs ceiling
      t: c.t,
      spend,
      zone: c.zone,
    };
  });
}
