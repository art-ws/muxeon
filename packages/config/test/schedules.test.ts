// The deferred-chain caps in the config (§21.6, FR-193): a CLOSED top-level
// block. Every violation is fatal with its JSON-pointer path (FR-33) — a typo in
// a cap must not become a silent default in a subsystem that types into panes.

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/error";
import { type MuxeonConfig, validateStructure } from "../src/schema";

const base = (schedules?: unknown): Record<string, unknown> => ({
  server: { port: 8080 },
  agents: [{ name: "muxeon", type: "claude", tmux: "muxeon" }],
  topology: { muxeon: ["shagin"], shagin: ["muxeon"] },
  channels: [{ type: "webchat", port: 8091, auth: { mode: "users" } }],
  users: [{ name: "shagin", auth: { password: "x" }, channels: { webchat: true } }],
  ...(schedules !== undefined ? { schedules } : {}),
});

const parse = (schedules?: unknown): MuxeonConfig => validateStructure(base(schedules));

const pathOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ConfigError ? (error.path ?? "(no path)") : `unexpected ${error}`;
  }
  return "(no error)";
};

describe("schedules block (§21.6)", () => {
  test("absent ⇒ the feature runs on its defaults, and nothing appears in the config", () => {
    expect(parse().schedules).toBeUndefined();
  });

  test("a full block round-trips verbatim", () => {
    const block = {
      enabled: true,
      maxChainsPerAgent: 8,
      maxItems: 16,
      minDelay: "5s",
      maxDelay: "24h",
      maxText: 32768,
      idleWait: "60s",
      catchUpGrace: "10m",
    };
    expect(parse(block).schedules).toEqual(block);
  });

  test("the switch alone is a legal block — every cap keeps its default", () => {
    expect(parse({ enabled: false }).schedules).toEqual({ enabled: false });
  });

  test("an unknown field is fatal, with its pointer", () => {
    expect(pathOf(() => parse({ maxChains: 4 }))).toBe("/schedules/maxChains");
  });

  test("a cap must be a positive integer — zero chains is a typo, not a policy", () => {
    expect(pathOf(() => parse({ maxItems: 0 }))).toBe("/schedules/maxItems");
    expect(pathOf(() => parse({ maxItems: -1 }))).toBe("/schedules/maxItems");
    expect(pathOf(() => parse({ maxChainsPerAgent: 1.5 }))).toBe("/schedules/maxChainsPerAgent");
  });

  test("durations use the config's own grammar", () => {
    expect(pathOf(() => parse({ idleWait: "soon" }))).toBe("/schedules/idleWait");
    expect(pathOf(() => parse({ catchUpGrace: 600 }))).toBe("/schedules/catchUpGrace");
    expect(parse({ minDelay: "500ms" }).schedules?.minDelay).toBe("500ms");
  });

  // A floor above the horizon can only ever answer "no" — that is a mistake, and
  // the operator should meet it at boot, not as a stream of refusals later.
  test("a floor above the horizon is fatal", () => {
    expect(pathOf(() => parse({ minDelay: "2h", maxDelay: "10m" }))).toBe("/schedules/minDelay");
    expect(pathOf(() => parse({ minDelay: "10m", maxDelay: "2h" }))).toBe("(no error)");
  });
});
