// The header's "up 3d · quiet 2h" (§5.5, FR-197) — the maths, kept pure so the
// component is fetch + markup. Two things carry the weight: the spans age forward
// between polls, and an UNWITNESSED quiet span is a floor, never a measurement.

import { describe, expect, test } from "bun:test";
import { clockLabel, clockTitle, fmtSpan } from "../src/session-clock";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The identity translator — the pure functions never touch a dictionary. */
const en = (text: string): string => text;

describe("fmtSpan (§5.5)", () => {
  test("one unit, rounded down, seconds under a minute", () => {
    expect(fmtSpan(0)).toBe("0s");
    expect(fmtSpan(45_000)).toBe("45s");
    expect(fmtSpan(59_999)).toBe("59s");
    expect(fmtSpan(MIN)).toBe("1m");
    expect(fmtSpan(59 * MIN + 59_000)).toBe("59m");
    expect(fmtSpan(HOUR)).toBe("1h");
    expect(fmtSpan(23 * HOUR + 59 * MIN)).toBe("23h");
    expect(fmtSpan(DAY)).toBe("1d");
    expect(fmtSpan(3 * DAY + 7 * HOUR)).toBe("3d");
  });

  test("a negative span (a clock that jumped) is floored at zero, never rendered as '-1m'", () => {
    expect(fmtSpan(-5_000)).toBe("0s");
  });
});

describe("clockLabel (§5.5, FR-197)", () => {
  test("the operator's shape: up 3d · quiet 2h", () => {
    const label = clockLabel({
      uptimeMs: 3 * DAY + HOUR,
      quietForMs: 2 * HOUR,
      lastActivity: "tokens",
      observedForMs: 5 * DAY,
    });
    expect(label).toEqual({
      up: "3d",
      quiet: "2h",
      quietIsFloor: false,
      lastActivity: "tokens",
    });
  });

  test("spans age forward by the time since the sample arrived", () => {
    const clock = { uptimeMs: 59 * MIN, quietForMs: 30_000, observedForMs: 2 * HOUR };
    expect(clockLabel(clock, 0)).toMatchObject({ up: "59m", quiet: "30s" });
    // two minutes later, without a refetch, both have moved — and the uptime has
    // crossed into the next unit rather than sitting at a stale "59m"
    expect(clockLabel(clock, 2 * MIN)).toMatchObject({ up: "1h", quiet: "2m" });
  });

  test("a down agent has no uptime — the chip shows the quiet span alone", () => {
    const label = clockLabel({ quietForMs: 3 * HOUR, lastActivity: "turn", observedForMs: DAY });
    expect(label.up).toBeUndefined();
    expect(label.quiet).toBe("3h");
  });

  test("nothing witnessed yet ⇒ the quiet span is a FLOOR of the observation window", () => {
    // Not "quiet 0s" and not "quiet forever": all the coordinator can say is that
    // it has seen nothing in the 12 minutes it has been watching (§10.34).
    const label = clockLabel({ uptimeMs: 4 * DAY, observedForMs: 12 * MIN });
    expect(label).toEqual({ up: "4d", quiet: "≥12m", quietIsFloor: true });
  });

  test("the floor ages forward too", () => {
    expect(clockLabel({ observedForMs: 50_000 }, 20_000).quiet).toBe("≥1m");
  });
});

describe("clockTitle (§5.5)", () => {
  test("spells out both facts and names the newest signal", () => {
    const label = clockLabel({
      uptimeMs: 2 * DAY,
      quietForMs: 90 * MIN,
      lastActivity: "transport",
      observedForMs: 3 * DAY,
    });
    expect(clockTitle(label, en)).toBe("session up for 2d · last sign of life 1h ago (transport)");
  });

  test("a floor says so in words — the '≥' alone would not", () => {
    const label = clockLabel({ uptimeMs: HOUR, observedForMs: 12 * MIN });
    expect(clockTitle(label, en)).toBe(
      "session up for 1h · no sign of life since the coordinator started 12m ago",
    );
  });

  test("no uptime ⇒ the tooltip is the quiet half alone, with no dangling separator", () => {
    const label = clockLabel({ quietForMs: 2 * HOUR, lastActivity: "tokens", observedForMs: DAY });
    expect(clockTitle(label, en)).toBe("last sign of life 2h ago (tokens)");
  });

  test("every visible string goes through the translator", () => {
    const seen: string[] = [];
    const spy = (text: string): string => {
      seen.push(text);
      return text;
    };
    clockTitle(
      clockLabel({ uptimeMs: HOUR, quietForMs: MIN, lastActivity: "turn", observedForMs: HOUR }),
      spy,
    );
    expect(seen).toEqual(["session up for", "last sign of life", "ago", "turn"]);
  });
});
