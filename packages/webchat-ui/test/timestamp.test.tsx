// §12.7 (FR-151): the relative-time phrase behind the timestamp tooltip — the
// bucket boundaries (seconds → minutes → hours → days) and the panel-language
// wording; the component renders the absolute time and carries NO title until
// hovered (the phrase is computed at hover time, never staled by render age).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeStamp, relativeTime } from "../src/timestamp";

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const ago = (ms: number): number => NOW - ms;

describe("relativeTime (FR-151)", () => {
  test("buckets: seconds, minutes, hours, days", () => {
    expect(relativeTime(ago(5_000), NOW, "en")).toBe("5 seconds ago");
    expect(relativeTime(ago(5 * 60_000), NOW, "en")).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3_600_000), NOW, "en")).toBe("3 hours ago");
    expect(relativeTime(ago(2 * 86_400_000), NOW, "en")).toBe("2 days ago");
  });

  test("numeric:auto keeps the natural words at the origin", () => {
    expect(relativeTime(NOW, NOW, "en")).toBe("now");
    expect(relativeTime(ago(86_400_000), NOW, "en")).toBe("yesterday");
  });

  test("the panel's language drives the wording", () => {
    expect(relativeTime(ago(5 * 60_000), NOW, "ru")).toBe("5 минут назад");
    expect(relativeTime(ago(86_400_000), NOW, "ru")).toBe("вчера");
  });

  test("future timestamps read forward (clock skew must not produce nonsense)", () => {
    expect(relativeTime(NOW + 5 * 60_000, NOW, "en")).toBe("in 5 minutes");
  });
});

describe("TimeStamp (FR-151)", () => {
  test("renders the absolute time and no tooltip before hover", () => {
    const html = renderToStaticMarkup(<TimeStamp ts={NOW} className="transport-time" />);
    expect(html).toContain(new Date(NOW).toLocaleTimeString());
    expect(html).toContain('class="transport-time"');
    expect(html).not.toContain("title=");
  });
});
