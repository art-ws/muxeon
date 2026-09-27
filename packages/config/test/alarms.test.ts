// The alarm caps in the config (§22.8, FR-207): a CLOSED top-level block, ON by
// default. Every violation is fatal with its JSON-pointer path (FR-33) — a typo
// must not quietly change how loud an agent is allowed to cry for help.

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/error";
import {
  ALARMS_DEFAULT_MAX_OPTIONS,
  ALARMS_DEFAULT_MAX_OPTION_LENGTH,
  ALARMS_DEFAULT_MAX_TEXT,
  type MuxeonConfig,
  validateStructure,
} from "../src/schema";

const base = (alarms?: unknown): Record<string, unknown> => ({
  server: { port: 8080 },
  agents: [{ name: "muxeon", type: "claude", tmux: "muxeon" }],
  topology: { muxeon: ["alex"], alex: ["muxeon"] },
  channels: [{ type: "webchat", port: 8091, auth: { mode: "users" } }],
  users: [{ name: "alex", auth: { password: "x" }, channels: { webchat: true } }],
  ...(alarms !== undefined ? { alarms } : {}),
});

const parse = (alarms?: unknown): MuxeonConfig => validateStructure(base(alarms));

const pathOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ConfigError ? (error.path ?? "(no path)") : `unexpected ${error}`;
  }
  return "(no error)";
};

describe("alarms block (§22.8)", () => {
  test("absent ⇒ nothing in the config — the server applies the defaults (ON)", () => {
    expect(parse().alarms).toBeUndefined();
  });

  test("the defaults are exported for the server to apply", () => {
    expect(ALARMS_DEFAULT_MAX_TEXT).toBe(4096);
    expect(ALARMS_DEFAULT_MAX_OPTIONS).toBe(6);
    expect(ALARMS_DEFAULT_MAX_OPTION_LENGTH).toBe(80);
  });

  test("a full block round-trips verbatim", () => {
    const block = { enabled: false, maxText: 2048, maxOptions: 4, maxOptionLength: 40 };
    expect(parse(block).alarms).toEqual(block);
  });

  test("an unknown field is fatal, with its path", () => {
    expect(pathOf(() => parse({ loud: true }))).toBe("/alarms/loud");
  });

  test("enabled must be a boolean", () => {
    expect(pathOf(() => parse({ enabled: "yes" }))).toBe("/alarms/enabled");
  });

  test("a cap must be a positive integer — zero, negatives and fractions are fatal", () => {
    expect(pathOf(() => parse({ maxText: 0 }))).toBe("/alarms/maxText");
    expect(pathOf(() => parse({ maxOptions: -1 }))).toBe("/alarms/maxOptions");
    expect(pathOf(() => parse({ maxOptionLength: 1.5 }))).toBe("/alarms/maxOptionLength");
  });

  test("the block must be an object", () => {
    expect(pathOf(() => parse([]))).toBe("/alarms");
  });
});
