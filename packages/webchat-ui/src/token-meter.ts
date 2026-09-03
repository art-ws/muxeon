// Pure helpers for the header token meter (§12.8, FR-103): the health colour (for
// both the orb and each histogram bar), number formatting, and the bar geometry.
// Kept out of the TSX so bun tests can pin the maths; the component is a thin view.

import type { TokenBucket, TokenSeries } from "./types";

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

/** current as an integer percentage of the ceiling — the "36%" the orb shows. */
export function fmtPercent(current: number, maxThreshold: number): number {
  if (maxThreshold <= 0) return 0;
  return Math.round((current / maxThreshold) * 100);
}

/**
 * The orb's caption and its tooltip (§12.8, FR-103). The caption is the PERCENTAGE
 * ALONE: the absolute count is long, changes on every sample and competes with the
 * histogram for the header's width, while the number a reader acts on is "how close
 * to the ceiling". The exact count stays one hover away, together with the ceiling
 * it is a percentage OF — a bare "23%" is unreadable without it.
 *
 * With no usable ceiling there is no percentage to state, so the caption degrades to
 * the count itself rather than claiming a meaningless "0%".
 */
export function orbText(
  current: number,
  maxThreshold: number,
  unit: string,
): { readonly label: string; readonly title: string } {
  const count = `${fmtTokens(current)} ${unit}`;
  if (maxThreshold <= 0) return { label: count, title: count };
  const pct = fmtPercent(current, maxThreshold);
  return { label: `${pct}%`, title: `${count} / ${fmtTokens(maxThreshold)} (${pct}%)` };
}

// ── Histogram geometry: a fixed-pitch TIME grid (T344, operator 2026-09-03) ──
//
// Before T344 the columns were laid out BY INDEX inside a stretched viewBox: the
// fewer buckets there were, the wider each one drew, and an interval with no samples
// simply vanished — two columns an hour apart sat shoulder to shoulder. Now every
// column occupies exactly `SLOT_W` px on a grid of real time, so a silent interval
// leaves an EMPTY slot of the same width and the picture keeps its time axis.

/** Grid steps of the two resolutions. */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Mirror of the sampler's `minuteSpan` default (§12.8) — used when the wire omits it. */
export const DEFAULT_MINUTE_SPAN_MS = 60 * MINUTE_MS;

/**
 * Column pitch in PIXELS — fixed, never wider (operator: "не превышала 5px"). Every
 * column, hourly or per-minute, is exactly this wide, and so is the gap left by an
 * interval that has no samples: same width means the eye can compare two columns by
 * height alone, and a hole in the history reads as a hole.
 */
export const SLOT_W = 5;

/** One histogram bar (px): geometry, health colour, and tooltip data. */
export interface HistBar {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Health colour of the LEVEL at this bucket (value vs ceiling — like the orb). */
  readonly color: string;
  /** Bucket start (unix ms) — for the tooltip. */
  readonly t: number;
  /** Tokens SPENT in this bucket (Δ level vs the previous SAMPLED bucket of the zone). */
  readonly spend: number;
  /** Which resolution this column belongs to (drives the X-axis colour band). */
  readonly zone: "hour" | "minute";
}

/** The whole histogram in pixels: what to draw and how wide the two zones are. */
export interface HistLayout {
  readonly bars: readonly HistBar[];
  /** Total drawn width (px) — the SVG's width; the box right-aligns it under the orb. */
  readonly width: number;
  /** Width of the hourly (older, left) zone — 0 when no hourly column fits or exists. */
  readonly hoursW: number;
  /** Width of the per-minute (recent, right) zone. */
  readonly minutesW: number;
  /** Hourly columns dropped because the box was too narrow (the OLDEST ones). */
  readonly droppedHours: number;
}

const EMPTY: HistLayout = { bars: [], width: 0, hoursW: 0, minutesW: 0, droppedHours: 0 };

/**
 * Spend per bucket: Δ level vs the previous bucket the sampler actually RECORDED in
 * that resolution, clamped ≥0 (a drop from `/compact` or `/clear` is not consumption).
 * A gap in the grid is not a reset — the comparison skips over it to the last level we
 * really saw, so the spend after a silence is attributed to the column that ends it.
 */
function spends(buckets: readonly TokenBucket[]): readonly number[] {
  return buckets.map((b, i) => {
    const prev = buckets[i - 1];
    return prev === undefined ? 0 : Math.max(0, b.tokens - prev.tokens);
  });
}

/** A bucket pinned to its slot on the zone's time grid, with its spend. */
interface Placed {
  readonly slot: number;
  readonly bucket: TokenBucket;
  readonly spend: number;
}

/** Drop buckets that fall outside the grid (clock skew, stale data), keep the rest. */
function place(
  buckets: readonly TokenBucket[],
  gridStart: number,
  step: number,
  slots: number,
  cut: number,
): readonly Placed[] {
  const sp = spends(buckets);
  const out: Placed[] = [];
  for (const [i, bucket] of buckets.entries()) {
    const slot = Math.round((bucket.t - gridStart) / step);
    if (slot < cut || slot >= slots) continue;
    out.push({ slot, bucket, spend: sp[i] ?? 0 });
  }
  return out;
}

/**
 * Lay the two zones out inside a box `boxWidth` px wide, `height` px tall.
 *
 * **Widths.** Columns sit on a time grid at a fixed `SLOT_W` pitch, so the per-minute
 * zone — always the whole `minuteSpan`, one column per minute whether or not that
 * minute was sampled — is ALWAYS the same width. The hourly zone takes whatever is
 * left and shows as many columns as fit, dropping the OLDEST first: the deep history
 * is what a narrow window can afford to lose, the last hour of detail is not. On a box
 * too narrow even for the minute zone, the minute columns trim the same way.
 *
 * **Heights.** A column's height is the tokens spent in that bucket (see `spends`),
 * scaled to the busiest VISIBLE column of its OWN zone — hours and minutes normalise
 * independently (an hour's spend dwarfs a minute's; a shared scale flattens the minute
 * bars), and a spike scrolled out of the box no longer flattens the ones on screen.
 *
 * **Colour** stays the green→red health of the bucket's ABSOLUTE level (`tokens /
 * maxThreshold`, the orb's scale), decoupled from height: a short column can be red
 * (little spent while the context was nearly full) and a tall one green.
 */
export function layoutHistogram(
  series: TokenSeries,
  boxWidth: number,
  height: number,
  now: number,
): HistLayout {
  // A box of 0 means NOT MEASURED YET (or never measured — a browser without a
  // ResizeObserver): lay out the WHOLE grid and let the box's `overflow: hidden`
  // crop it from the left. The picture is then one sliver-column off at the far
  // edge, which is worth it — an unmeasured box used to draw NOTHING, and a widget
  // that can vanish outright is worse than one that is 4px imprecise (T345).
  const capacity = boxWidth <= 0 ? Number.POSITIVE_INFINITY : Math.floor(boxWidth / SLOT_W); // whole columns
  if (capacity < 1 || height <= 0) return EMPTY;

  // Per-minute grid: `minuteSpan` slots ending at the current minute. Anchored on the
  // LATEST of the browser clock and the data, so a browser running behind the server
  // still shows the newest column instead of dropping it off the grid.
  const spanMs = series.minuteSpanMs ?? DEFAULT_MINUTE_SPAN_MS;
  const minuteSlots = Math.max(1, Math.round(spanMs / MINUTE_MS));
  const anchor = Math.max(now, series.updatedAt, series.minutes.at(-1)?.t ?? 0);
  const minuteEnd = Math.floor(anchor / MINUTE_MS) * MINUTE_MS;
  const minuteStart = minuteEnd - (minuteSlots - 1) * MINUTE_MS;

  // Hourly grid: from the oldest hourly bucket the server still keeps to the newest —
  // data-driven, so a young agent gets a short blue zone rather than a 24h empty band,
  // while a gap INSIDE that range keeps its empty slot.
  const oldestHour = series.hours[0]?.t;
  const newestHour = series.hours.at(-1)?.t;
  const hourSlots =
    oldestHour === undefined || newestHour === undefined
      ? 0
      : Math.round((newestHour - oldestHour) / HOUR_MS) + 1;

  const minuteVis = Math.min(minuteSlots, capacity); // the fixed zone claims the box first
  const hourVis = Math.min(hourSlots, capacity - minuteVis);
  const hoursW = hourVis * SLOT_W;
  const minutesW = minuteVis * SLOT_W;
  const hourCut = hourSlots - hourVis; // oldest columns that did not fit
  const minuteCut = minuteSlots - minuteVis;

  const bars: HistBar[] = [];
  const draw = (
    placed: readonly Placed[],
    zone: "hour" | "minute",
    cut: number,
    originX: number,
  ): void => {
    const maxSpend = Math.max(1, ...placed.map((p) => p.spend));
    for (const p of placed) {
      const h = p.spend > 0 ? Math.max((p.spend / maxSpend) * height, 1) : 0;
      bars.push({
        x: originX + (p.slot - cut) * SLOT_W,
        y: height - h,
        w: SLOT_W,
        h,
        color: healthColor(healthRatio(p.bucket.tokens, series.maxThreshold)),
        t: p.bucket.t,
        spend: p.spend,
        zone,
      });
    }
  };
  if (hourVis > 0 && oldestHour !== undefined) {
    draw(place(series.hours, oldestHour, HOUR_MS, hourSlots, hourCut), "hour", hourCut, 0);
  }
  draw(
    place(series.minutes, minuteStart, MINUTE_MS, minuteSlots, minuteCut),
    "minute",
    minuteCut,
    hoursW,
  );

  return { bars, width: hoursW + minutesW, hoursW, minutesW, droppedHours: hourCut };
}

/** What the width measurement needs of a DOM node — its inner width in CSS pixels. */
export interface WidthNode {
  readonly clientWidth: number;
}

type WidthObserverCtor = new (
  callback: () => void,
) => {
  observe: (node: WidthNode) => void;
  disconnect: () => void;
};

/**
 * Report `node`'s width now and on every resize; returns the detach.
 *
 * Framework-free on purpose — this is the piece that broke. The first cut measured
 * inside a `useEffect([])`, which runs on MOUNT, while the meter still renders
 * `null` (it has no series until the first poll answers). The box did not exist
 * yet, the effect bailed, its empty deps kept it from ever running again, and the
 * histogram was gone for good. The component now attaches this through a CALLBACK
 * REF — fired when the node itself appears, however many renders later — and the
 * logic is testable without a DOM.
 */
export function measureWidth(node: WidthNode, onWidth: (width: number) => void): () => void {
  onWidth(node.clientWidth);
  const Observer = (globalThis as { ResizeObserver?: WidthObserverCtor }).ResizeObserver;
  if (Observer === undefined) return () => undefined; // no live updates; the box stays as measured
  const observer = new Observer(() => onWidth(node.clientWidth));
  observer.observe(node);
  return () => observer.disconnect();
}
