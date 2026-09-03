// The histogram as it actually renders (§12.8, FR-103; T344). The geometry is pinned
// in token-meter.test.ts; what is checked here is the JSX — the zone washes are the
// widths the layout computed, an ABSENT zone leaves no zero-width `<rect>` behind, and
// an unmeasured box draws the full grid rather than nothing (T345 — drawing nothing
// there is exactly how the histogram disappeared from the live header).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HistCanvas } from "../src/TokenMeter";
import { SLOT_W, layoutHistogram } from "../src/token-meter";
import type { TokenSeries } from "../src/types";

const M = 60_000;
const H = 3_600_000;
const T0 = 100 * H;

const series: TokenSeries = {
  hours: [
    { t: T0 - 2 * H, tokens: 100 },
    { t: T0 - 1 * H, tokens: 250 },
  ],
  minutes: [
    { t: T0 - 2 * M, tokens: 500 },
    { t: T0 - 1 * M, tokens: 520 },
  ],
  current: 520,
  updatedAt: T0 - 1 * M,
  maxThreshold: 1000,
};

const draw = (s: TokenSeries, box: number): string =>
  renderToStaticMarkup(
    <HistCanvas
      layout={layoutHistogram(s, box, 22, T0)}
      height={22}
      unit="tok"
      hourly="hourly"
      perMinute="per-minute"
    />,
  );

describe("histogram canvas (§12.8, FR-103; T344)", () => {
  test("both zones render as washes of the computed width, columns on top", () => {
    const out = draw(series, 1000);
    expect(out).toContain(`width="${(2 + 60) * SLOT_W}"`); // svg == hours + minutes
    expect(out).toContain(">hourly</title>");
    expect(out).toContain(">per-minute</title>");
    // one visible column per zone (the first of each has no predecessor ⇒ no spend)
    expect(out.match(/<rect/g)?.length).toBe(4); // 2 washes + 2 columns
    for (const w of out.matchAll(/<rect [^>]*width="(\d+)"/g)) {
      expect([2 * SLOT_W, 60 * SLOT_W, SLOT_W]).toContain(Number(w[1]));
    }
  });

  test("no hourly history ⇒ no hourly wash at all (not a zero-width rect)", () => {
    const out = draw({ ...series, hours: [] }, 1000);
    expect(out).not.toContain(">hourly</title>");
    expect(out).toContain(">per-minute</title>");
  });

  test("a box too narrow for one column ⇒ nothing drawn, not an empty svg", () => {
    expect(draw(series, SLOT_W - 1)).toBe("");
  });

  test("an unmeasured box still draws — the full grid, for the CSS to crop (T345)", () => {
    // The box measures 0 until it exists; drawing nothing there is how the whole
    // histogram vanished from the stand's header.
    const out = draw(series, 0);
    expect(out).toContain(`width="${(2 + 60) * SLOT_W}"`);
    expect(out).toContain(">per-minute</title>");
  });

  test("every column carries its time + spend tooltip", () => {
    const out = draw(series, 1000);
    expect(out).toMatch(/<title>\d\d:\d\d · \d+ tok<\/title>/);
  });
});
