// Time helpers for the scheduler (§6.3). cron/`at` are computed in the routine's tz
// (default UTC). croner owns DST-aware cron (spring gaps skipped, fall folds run once);
// this module covers the one-shot `at` wall-clock → instant conversion and the cron
// factory. (T27 layers skip-missed and orphan logic on top.)

import { Cron } from "croner";

/** A croner Cron for `schedule` in `tz` (default UTC). */
export function cronFor(schedule: string, tz?: string): Cron {
  return new Cron(schedule, tz !== undefined ? { timezone: tz } : {});
}

const HAS_OFFSET = /[zZ]$|[+-]\d{2}:?\d{2}$/;

/**
 * Interpret an `at` time (§6.1) as a unix-ms instant. A value with a Z/offset is
 * absolute; a bare local time is read as wall-clock in `tz`. Returns NaN if unparseable.
 */
export function wallTimeToInstant(at: string, tz?: string): number {
  if (tz === undefined || HAS_OFFSET.test(at)) return Date.parse(at);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(at);
  if (m === null) return Number.NaN;
  const [, Y = "", Mo = "", D = "", H = "", Mi = "", S = "0"] = m;
  // Take the fields as if UTC, then subtract the tz's offset at that instant.
  const asIfUtc = Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S));
  return asIfUtc - tzOffsetMs(asIfUtc, tz);
}

/** The tz's offset from UTC (ms) at a given instant: (local wall time) − (utc wall time). */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asLocal = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asLocal - utcMs;
}
