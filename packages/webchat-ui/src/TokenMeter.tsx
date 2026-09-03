// The chat-header token meter (§12.8, FR-103): a spend histogram (each bar = tokens
// spent that minute/hour, coloured by the health of the level then, same green→yellow→
// red scale as the orb) over a two-colour full-height zone wash marking the hourly
// (older) vs per-minute (recent) regions, with per-bar tooltips (time + spend); then,
// pinned right, the health orb with the token count. Polls GET /api/agents/:name/
// tokens; renders nothing when the peer's type isn't tracked.
//
// Since T344 the columns sit on a fixed 5px TIME grid instead of being stretched to
// the container, so the SVG is drawn at its true pixel size and the box is MEASURED
// (ResizeObserver, like the feed pin) to decide how many hourly columns fit. Before
// the first measurement the box is 0 wide and the histogram simply doesn't draw —
// one frame, and never a wrong picture. Geometry/colour maths live in token-meter.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTokenSeries } from "./api";
import { useT } from "./i18n-context";
import {
  type HistBar,
  type HistLayout,
  fmtTokens,
  healthColor,
  healthRatio,
  layoutHistogram,
  measureWidth,
  orbText,
} from "./token-meter";
import type { TokenSeries } from "./types";

/** Refresh cadence: the series changes at most once per sample (~60s), so 15s is ample. */
const REFRESH_MS = 15_000;
/** Histogram box height (viewBox units == px vertically); bars fill it, baseline flush at the bottom. */
const HIST_H = 22;
/** Zone colours (outside the green→red bar palette): a full-height translucent wash
 *  marks the region — blue = hourly (older), purple = per-minute (recent). */
const HOUR_BG = "hsla(210, 75%, 55%, 0.16)";
const MIN_BG = "hsla(275, 65%, 60%, 0.16)";

/** Bucket-time label for a tooltip (local time; the axis band marks the resolution). */
function fmtTime(t: number): string {
  const d = new Date(t);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function Bars({ bars, unit }: { bars: readonly HistBar[]; unit: string }): React.JSX.Element {
  return (
    <>
      {bars
        .filter((b) => b.h > 0)
        .map((b) => (
          <rect
            key={b.x}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill={b.color}
            style={{ filter: `drop-shadow(0 0 1.5px ${b.color})` }}
          >
            <title>{`${fmtTime(b.t)} · ${fmtTokens(b.spend)} ${unit}`}</title>
          </rect>
        ))}
    </>
  );
}

/**
 * The drawn histogram at its true pixel size (T344): the two zone washes, then the
 * columns. Split out of {@link TokenMeter} so a render test can pin the JSX branches
 * — an empty zone must not leave a zero-width `<rect>` behind.
 */
export function HistCanvas({
  layout,
  height,
  unit,
  hourly,
  perMinute,
}: {
  layout: HistLayout;
  height: number;
  unit: string;
  hourly: string;
  perMinute: string;
}): React.JSX.Element | null {
  if (layout.width <= 0) return null;
  return (
    <svg
      width={layout.width}
      height={height}
      viewBox={`0 0 ${layout.width} ${height}`}
      role="img"
      aria-label="token spend histogram"
    >
      {/* full-height zone wash marks the region — blue = hourly (older), purple = per-minute */}
      {layout.hoursW > 0 && (
        <rect x={0} y={0} width={layout.hoursW} height={height} fill={HOUR_BG}>
          <title>{hourly}</title>
        </rect>
      )}
      {layout.minutesW > 0 && (
        <rect x={layout.hoursW} y={0} width={layout.minutesW} height={height} fill={MIN_BG}>
          <title>{perMinute}</title>
        </rect>
      )}
      <Bars bars={layout.bars} unit={unit} />
    </svg>
  );
}

/**
 * The histogram box's inner width in px, kept live by a ResizeObserver; 0 until the
 * box exists (and in a DOM-less render), which the layout reads as "not measured"
 * and answers with the full grid rather than with nothing.
 *
 * A CALLBACK REF, not an effect: the meter renders `null` until its first poll
 * answers, so an effect with empty deps fires while there is no box to measure and
 * never gets a second chance — that is exactly how the histogram disappeared (T345).
 * A callback ref fires when the node attaches, whenever that turns out to be.
 */
function useBoxWidth(): { ref: (node: HTMLDivElement | null) => void; width: number } {
  const [width, setWidth] = useState(0);
  const detach = useRef<(() => void) | undefined>(undefined);
  const ref = useCallback((node: HTMLDivElement | null): void => {
    detach.current?.();
    detach.current = node === null ? undefined : measureWidth(node, setWidth);
  }, []);
  return { ref, width };
}

export function TokenMeter({ peer }: { peer: string }): React.JSX.Element | null {
  const t = useT();
  const [series, setSeries] = useState<TokenSeries | undefined>(undefined);
  const box = useBoxWidth();

  useEffect(() => {
    let alive = true;
    setSeries(undefined); // drop the previous peer's data so it can't flash
    const load = (): void => {
      void fetchTokenSeries(peer)
        .then((next) => {
          if (alive) setSeries(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [peer]);

  if (series === undefined) return null;
  const nCols = series.hours.length + series.minutes.length;
  if (nCols === 0 && series.current === 0) return null;

  const unit = t("tok");
  const color = healthColor(healthRatio(series.current, series.maxThreshold));
  // Percentage on the header, exact count in the tooltip (operator request).
  const { label, title } = orbText(series.current, series.maxThreshold, unit);
  const layout = layoutHistogram(series, box.width, HIST_H, Date.now());

  return (
    <div className="token-meter">
      {/* the box is the measured surface; the histogram hugs its RIGHT edge, so "now"
          always sits next to the orb and the older hours fall off to the left */}
      <div className="token-hist" ref={box.ref}>
        {nCols > 0 && (
          <HistCanvas
            layout={layout}
            height={HIST_H}
            unit={unit}
            hourly={t("hourly")}
            perMinute={t("per-minute")}
          />
        )}
      </div>
      <div className="token-orb-wrap" title={title}>
        <span
          className="token-orb"
          style={{ background: color, boxShadow: `0 0 5px ${color}` }}
          aria-hidden="true"
        />
        <span className="token-orb-label">{label}</span>
      </div>
    </div>
  );
}
