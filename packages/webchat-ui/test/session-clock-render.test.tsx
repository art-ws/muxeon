// The clock chip as it actually renders (§5.5, FR-197). The maths is covered in
// session-clock.test.ts; what is checked here is the JSX branch — a down agent has
// no uptime, and the separator must go with it rather than hang after nothing.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClockChip } from "../src/SessionClock";
import { clockLabel, clockTitle } from "../src/session-clock";

const en = (text: string): string => text;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const chip = (clock: Parameters<typeof clockLabel>[0]): string => {
  const label = clockLabel(clock);
  return renderToStaticMarkup(
    <ClockChip
      {...(label.up !== undefined ? { up: `${en("up")} ${label.up}` } : {})}
      quiet={`${en("quiet")} ${label.quiet}`}
      title={clockTitle(label, en)}
    />,
  );
};

describe("clock chip (§5.5, FR-197)", () => {
  test("a live agent renders both spans, separated", () => {
    const out = chip({
      uptimeMs: 3 * DAY,
      quietForMs: 2 * HOUR,
      lastActivity: "tokens",
      observedForMs: 5 * DAY,
    });
    expect(out).toContain('class="session-clock"');
    expect(out).toContain("up 3d");
    expect(out).toContain("quiet 2h");
    expect(out).toContain('class="session-clock-sep"');
    expect(out).toContain('title="session up for 3d · last sign of life 2h ago (tokens)"');
  });

  test("a down agent renders the quiet span alone — no uptime, no dangling separator", () => {
    const out = chip({ quietForMs: 3 * HOUR, lastActivity: "turn", observedForMs: DAY });
    expect(out).toContain("quiet 3h");
    expect(out).not.toContain("up ");
    expect(out).not.toContain("session-clock-sep");
  });

  test("an unwitnessed agent renders the floor, and the tooltip says why", () => {
    const out = chip({ uptimeMs: 4 * DAY, observedForMs: 720_000 });
    expect(out).toContain("quiet ≥12m");
    expect(out).toContain("no sign of life since the coordinator started 12m ago");
  });
});
