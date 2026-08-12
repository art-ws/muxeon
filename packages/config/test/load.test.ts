import { describe, expect, test } from "bun:test";
import type { EnvSource } from "../src/env";
import { ConfigError } from "../src/error";
import { loadConfig, normalizeConfigPaths, parseConfig, redact } from "../src/load";

const MONOLITH = JSON.stringify({
  server: { port: 8080, mcp: true },
  agents: [
    {
      name: "researcher",
      type: "claude",
      tmux: "researcher-session",
      provision: { command: "claude" },
    },
  ],
  topology: { researcher: ["operator"] },
  channels: [
    {
      type: "telegram",
      token: { $env: "TELEGRAM_TOKEN" },
      bindOperator: "operator",
      defaultTarget: "researcher",
    },
  ],
});

const envOf =
  (map: Record<string, string>): EnvSource =>
  (name) =>
    map[name];

describe("loadConfig pipeline (§7.2)", () => {
  test("loads a monolith and resolves channel secrets from $env", () => {
    const { config, secretPaths } = loadConfig(MONOLITH, {
      env: envOf({ TELEGRAM_TOKEN: "bot-123:secret" }),
    });
    expect(config.channels[0]?.token).toBe("bot-123:secret");
    expect(config.agents[0]?.tmux).toBe("researcher-session");
    expect(secretPaths).toEqual(["/channels/0/token"]);
  });

  test("a missing secret variable is fatal at start (§10.7)", () => {
    expect(() => loadConfig(MONOLITH, { env: envOf({}) })).toThrow(ConfigError);
  });

  test("an inline channel secret is rejected before resolution (§7.3)", () => {
    const inline = JSON.stringify({
      server: { port: 1 },
      agents: [],
      topology: {},
      channels: [{ type: "telegram", token: "inline-secret", bindOperator: "op" }],
    });
    expect(() => loadConfig(inline, { env: envOf({}) })).toThrow(ConfigError);
  });

  test("invalid JSON is a fatal ConfigError", () => {
    expect(() => parseConfig("{not json")).toThrow(ConfigError);
  });
});

// --- path normalization (T121, FR-82, §7.1) ----------------------------------
// A relative agent cwd must not splinter into three readings (server process
// cwd / agent cwd / tmux -c): with a known config location every agent path
// leaves the loader absolute.

describe("path normalization (FR-82, §7.1)", () => {
  const withPaths = JSON.stringify({
    server: { port: 8080 },
    agents: [
      {
        name: "makar",
        type: "claude",
        tmux: "makar",
        cwd: "../agents/worker",
        provision: { command: "claude", cwd: "./workspace" },
      },
      { name: "abs", type: "claude", tmux: "abs", cwd: "/srv/agent-abs" },
      { name: "bare", type: "claude", tmux: "bare" },
    ],
    topology: {},
    channels: [],
  });

  test("with baseFile, relative cwd and provision.cwd resolve from config_dir", () => {
    const { config } = loadConfig(withPaths, { baseFile: "/srv/muxeon/muxeon.config.json" });
    expect(config.agents[0]?.cwd).toBe("/srv/agents/worker");
    expect(config.agents[0]?.provision?.cwd).toBe("/srv/muxeon/workspace");
    expect(config.agents[1]?.cwd).toBe("/srv/agent-abs"); // absolute passes through
    expect(config.agents[2]?.cwd).toBeUndefined(); // no cwd — nothing invented
  });

  test("without baseFile (raw text) paths stay verbatim — the caller normalizes", () => {
    const { config } = loadConfig(withPaths);
    expect(config.agents[0]?.cwd).toBe("../agents/worker");
  });

  test("normalizeConfigPaths is exported and idempotent", () => {
    const { config } = loadConfig(withPaths);
    const once = normalizeConfigPaths(config, "/srv/muxeon");
    const twice = normalizeConfigPaths(once, "/srv/muxeon");
    expect(twice).toEqual(once);
    expect(once.agents[0]?.provision?.command).toBe("claude"); // the rest untouched
  });
});

describe("secret redaction (§7.3, §10.7, NFR-6)", () => {
  test("redact masks $env-sourced values, leaving the rest intact", () => {
    const { config, secretPaths } = loadConfig(MONOLITH, {
      env: envOf({ TELEGRAM_TOKEN: "bot-123:secret" }),
    });
    const safe = redact(config, secretPaths) as typeof config;
    expect(safe.channels[0]?.token).toBe("[redacted]");
    expect(safe.agents[0]?.tmux).toBe("researcher-session");
    // The real secret value must not appear anywhere in the serialized form:
    expect(JSON.stringify(safe)).not.toContain("bot-123:secret");
  });
});
