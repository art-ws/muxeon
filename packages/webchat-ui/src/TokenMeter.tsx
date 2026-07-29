// The chat-header token meter (§12.8, FR-103): a full-width spend histogram (each
// bar = tokens spent that minute/hour, coloured by the health of the level then,
// same green→yellow→red scale as the orb) over a two-colour full-height zone wash
// marking the hourly (older) vs per-minute (recent) regions, with per-bar tooltips
// (time + spend); then, pinned right, the health orb with the token count. Polls
// GET /api/agents/:name/tokens; renders nothing when the peer's type isn't tracked.
//
// The SVG uses a fixed viewBox stretched to the container (preserveAspectRatio
// "none") so it fills the width with NO pixel measurement — it can never fail to
// render on a layout-timing race. Geometry/colour maths live in token-meter.ts.

import { useEffect, useState } from "react";
import { fetchTokenSeries } from "./api";
import { useT } from "./i18n-context";
import {
  HIST_VBW,
  type HistBar,
  buildBars,
  fmtPercent,
  fmtTokens,
  healthColor,
  healthRatio,
  hourZoneWidth,
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

export function TokenMeter({ peer }: { peer: string }): React.JSX.Element | null {
  const t = useT();
  const [series, setSeries] = useState<TokenSeries | undefined>(undefined);

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
  const pct = fmtPercent(series.current, series.maxThreshold);
  const label = `${fmtTokens(series.current)} ${unit} (${pct}%)`;
  const bars = buildBars(series, HIST_H);
  const hoursW = hourZoneWidth(series);

  return (
    <div className="token-meter">
      <div className="token-hist">
        {nCols > 0 && (
          <svg
            width="100%"
            height={HIST_H}
            viewBox={`0 0 ${HIST_VBW} ${HIST_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="token spend histogram"
          >
            {/* full-height zone wash marks the region — blue = hourly (older), purple = per-minute */}
            {hoursW > 0 && (
              <rect x={0} y={0} width={hoursW} height={HIST_H} fill={HOUR_BG}>
                <title>{t("hourly")}</title>
              </rect>
            )}
            {hoursW < HIST_VBW && (
              <rect x={hoursW} y={0} width={HIST_VBW - hoursW} height={HIST_H} fill={MIN_BG}>
                <title>{t("per-minute")}</title>
              </rect>
            )}
            <Bars bars={bars} unit={unit} />
          </svg>
        )}
      </div>
      <div className="token-orb-wrap">
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
