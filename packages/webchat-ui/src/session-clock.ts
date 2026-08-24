// The chat header's session clock (§5.5, FR-197) — the maths behind
// "up 3d · quiet 2h". Pure: no fetch, no clock reading, no i18n; the component
// supplies `elapsedMs` (how long ago the sample arrived) and translates the two
// labels. The server sends DURATIONS, so nothing here compares a browser clock
// against a server one.

import type { PeerClock } from "./types";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * A span in ONE unit, rounded DOWN — the header has room for two of these, and
 * "up 3d" is what a human wants there; the tooltip carries the detail. Under a
 * minute reads in seconds so a just-restarted agent does not sit at "0m".
 */
export function fmtSpan(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE) return `${Math.floor(span / 1000)}s`;
  if (span < HOUR) return `${Math.floor(span / MINUTE)}m`;
  if (span < DAY) return `${Math.floor(span / HOUR)}h`;
  return `${Math.floor(span / DAY)}d`;
}

/** What the chip renders — already extrapolated to "now"; absent parts are omitted. */
export interface ClockLabel {
  /** Uptime span, e.g. "3d"; absent when the agent is down or the start is unknown. */
  readonly up?: string;
  /** Quiet span, e.g. "2h" — or the floor "≥12m" when nothing has been witnessed yet. */
  readonly quiet: string;
  /**
   * True when `quiet` is a FLOOR rather than a measurement: the coordinator has
   * seen no sign of life since it started, so all that can honestly be said is
   * "at least this long" (§10.34). The tooltip says so in words.
   */
  readonly quietIsFloor: boolean;
  /** Newest signal behind `quiet` (`transport` | `turn` | `tokens` | `session`). */
  readonly lastActivity?: string;
}

/** The tooltip: the same two facts in words, plus which signal was the newest. */
export function clockTitle(label: ClockLabel, t: (text: string) => string): string {
  const up = label.up === undefined ? undefined : `${t("session up for")} ${label.up}`;
  // A floor is spelled out in words — "at least" is exactly the thing a bare
  // duration would hide, and the chip has room for a "≥" but not for a sentence.
  const quiet = label.quietIsFloor
    ? `${t("no sign of life since the coordinator started")} ${label.quiet.slice(1)} ${t("ago")}`
    : `${t("last sign of life")} ${label.quiet} ${t("ago")}${
        label.lastActivity === undefined ? "" : ` (${t(label.lastActivity)})`
      }`;
  return up === undefined ? quiet : `${up} · ${quiet}`;
}

/**
 * Fold a fetched clock plus the time since it was fetched into the chip's labels.
 * Every duration grows with `elapsedMs`: a sample that is 40 s old still renders a
 * truthful span instead of drifting behind the wall clock.
 */
export function clockLabel(clock: PeerClock, elapsedMs = 0): ClockLabel {
  const since = Math.max(0, elapsedMs);
  const quietIsFloor = clock.quietForMs === undefined;
  const quietMs = (clock.quietForMs ?? clock.observedForMs) + since;
  return {
    ...(clock.uptimeMs !== undefined ? { up: fmtSpan(clock.uptimeMs + since) } : {}),
    quiet: quietIsFloor ? `≥${fmtSpan(quietMs)}` : fmtSpan(quietMs),
    quietIsFloor,
    ...(clock.lastActivity !== undefined ? { lastActivity: clock.lastActivity } : {}),
  };
}
