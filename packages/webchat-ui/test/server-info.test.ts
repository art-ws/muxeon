// formatServerInfo (FR-91): the Settings footer line. Locale-independent assertions
// only — the date renders in the viewer's locale.

import { describe, expect, test } from "bun:test";
import { formatServerInfo } from "../src/server-info";

describe("formatServerInfo (FR-91)", () => {
  test("composes version · commit · built <date> from a full info", () => {
    const line = formatServerInfo(
      { version: "0.0.0", commit: "78363b1", builtAt: "2026-06-09T20:45:05Z" },
      "built",
    );
    expect(line).toContain("TeamAI 0.0.0");
    expect(line).toContain("78363b1");
    expect(line).toContain("built ");
    expect(line.split(" · ")).toHaveLength(3);
  });

  test("omits commit and build time when absent", () => {
    expect(formatServerInfo({ version: "0.0.0" }, "built")).toBe("TeamAI 0.0.0");
  });

  test("an unparseable build time falls back to the raw string", () => {
    expect(formatServerInfo({ version: "1", builtAt: "not-a-date" }, "built")).toContain(
      "built not-a-date",
    );
  });
});
