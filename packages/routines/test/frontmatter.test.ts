import { describe, expect, test } from "bun:test";
import { RoutineParseError, parseFrontmatter } from "../src/frontmatter";

const cron = `---
id: nightly-report
schedule: "0 9 * * *"
tz: Europe/Moscow
target: writer
enabled: true
---
Summarize today's research and send it over.
`;

describe("parseFrontmatter (§6.1)", () => {
  test("parses a cron routine with all fields", () => {
    expect(parseFrontmatter(cron)).toEqual({
      id: "nightly-report",
      schedule: "0 9 * * *",
      once: false,
      tz: "Europe/Moscow",
      target: "writer",
      enabled: true,
      body: "Summarize today's research and send it over.",
    });
  });

  test("once is derived from schedule:once — there is no boolean field (§6.1)", () => {
    const r = parseFrontmatter("---\nid: kick\nschedule: once\n---\nwake up");
    expect(r.once).toBe(true);
    expect(r.schedule).toBe("once");
    expect(r.body).toBe("wake up");
  });

  test("enabled defaults to true when absent, and is honored when false (kill-switch)", () => {
    expect(parseFrontmatter("---\nid: a\nschedule: once\n---\nx").enabled).toBe(true);
    expect(parseFrontmatter("---\nid: a\nschedule: once\nenabled: false\n---\nx").enabled).toBe(
      false,
    );
  });

  test("an absolute `at` for once is kept as a string (not YAML-coerced)", () => {
    const r = parseFrontmatter("---\nid: a\nschedule: once\nat: 2026-07-01T09:00:00\n---\ngo");
    expect(r.at).toBe("2026-07-01T09:00:00");
  });

  test.each([
    ["no frontmatter", "just a body, no fences"],
    ["broken YAML", "---\nid: : :\n bad\n---\nx"],
    ["missing id", "---\nschedule: once\n---\nx"],
    ["missing schedule", "---\nid: a\n---\nx"],
    ["empty id", `---\nid: ""\nschedule: once\n---\nx`],
    ["non-boolean enabled", "---\nid: a\nschedule: once\nenabled: yep\n---\nx"],
  ])("rejects %s with RoutineParseError", (_label, content) => {
    expect(() => parseFrontmatter(content)).toThrow(RoutineParseError);
  });
});
