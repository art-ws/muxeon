import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/error";
import {
  DEFAULT_RENDEZVOUS_MAX_ATTEMPTS,
  DEFAULT_RENDEZVOUS_WINDOW,
  DEFAULT_WIP_LIMIT,
  assertChannelSecretsAreEnvRefs,
  resolveRendezvous,
  resolveWipLimit,
  validateStructure,
} from "../src/schema";

// A valid config as seen by validateStructure — i.e. AFTER $env resolution, so the
// channel token is already a plain string.
function validResolved() {
  return {
    server: { port: 8080, mcp: true, queueDir: "./queue", retain: { age: "7d", count: 1000 } },
    agents: [
      {
        name: "researcher",
        type: "claude",
        tmux: "researcher-session",
        cwd: "/work",
        provision: { command: "claude" },
      },
      { name: "writer", type: "claude", tmux: "writer-session" },
    ],
    topology: { researcher: ["writer", "operator"], writer: ["researcher"] },
    channels: [
      {
        type: "telegram",
        token: "resolved-token",
        bindOperator: "operator",
        defaultTarget: "researcher",
      },
    ],
  };
}

function grab(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (caught) {
    if (caught instanceof ConfigError) return caught;
    throw caught;
  }
  throw new Error("expected a ConfigError to be thrown");
}

describe("base schema validation (§7.1)", () => {
  test("accepts a valid resolved monolith and preserves channel fields", () => {
    const cfg = validateStructure(validResolved());
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.mcp).toBe(true);
    expect(cfg.agents).toHaveLength(2);
    expect(cfg.agents[0]?.provision?.command).toBe("claude");
    expect(cfg.topology.researcher).toEqual(["writer", "operator"]);
    expect(cfg.channels[0]?.bindOperator).toBe("operator");
    expect(cfg.channels[0]?.token).toBe("resolved-token"); // channel-specific field preserved
  });

  test("mcp defaults to true; channels default to []", () => {
    const cfg = validateStructure({ server: { port: 1 }, agents: [], topology: {} });
    expect(cfg.server.mcp).toBe(true);
    expect(cfg.channels).toEqual([]);
  });

  test("name (FR-90) is an optional non-empty string; absent ⇒ undefined (boot defaults it)", () => {
    expect(validateStructure({ ...validResolved(), name: "prod-cluster" }).name).toBe(
      "prod-cluster",
    );
    expect(validateStructure(validResolved()).name).toBeUndefined();
    expect(grab(() => validateStructure({ ...validResolved(), name: "" })).path).toBe("/name");
    expect(grab(() => validateStructure({ ...validResolved(), name: 42 })).path).toBe("/name");
  });

  test("provision.command may be an argv array", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [
        { name: "a", type: "claude", tmux: "a", provision: { command: ["claude", "--flag"] } },
      ],
      topology: {},
    });
    expect(cfg.agents[0]?.provision?.command).toEqual(["claude", "--flag"]);
  });

  test("agent.exchangeDir is an optional non-empty string (§13.1)", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", exchangeDir: "./x" }],
      topology: {},
    });
    expect(cfg.agents[0]?.exchangeDir).toBe("./x");
    expect(
      grab(() =>
        validateStructure({
          server: { port: 1 },
          agents: [{ name: "a", type: "claude", tmux: "a", exchangeDir: "" }],
          topology: {},
        }),
      ).path,
    ).toBe("/agents/0/exchangeDir");
  });

  test("provision.auto is an optional boolean (FR-50)", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [
        { name: "a", type: "claude", tmux: "a", provision: { command: "claude", auto: true } },
      ],
      topology: {},
    });
    expect(cfg.agents[0]?.provision?.auto).toBe(true);
    // absent → undefined (default false at the call site)
    expect(validateStructure(validResolved()).agents[0]?.provision?.auto).toBeUndefined();
    expect(
      grab(() =>
        validateStructure({
          server: { port: 1 },
          agents: [
            { name: "a", type: "claude", tmux: "a", provision: { command: "claude", auto: "yes" } },
          ],
          topology: {},
        }),
      ).path,
    ).toBe("/agents/0/provision/auto");
  });

  test("provision.teardown and the types block (FR-64): valid shapes pass", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [
        {
          name: "a",
          type: "claude",
          tmux: "a",
          provision: { command: "claude", teardown: { slash: "exit", graceMs: 3000 } },
        },
      ],
      topology: {},
      types: { claude: { teardown: { slash: "exit", keys: ["C-d"], graceMs: 5000 } } },
    });
    expect(cfg.agents[0]?.provision?.teardown).toEqual({ slash: "exit", graceMs: 3000 });
    expect(cfg.types?.claude?.teardown).toEqual({ slash: "exit", keys: ["C-d"], graceMs: 5000 });
    // types absent → undefined
    expect(validateStructure(validResolved()).types).toBeUndefined();
  });

  test("teardown.idle (FR-92): duration string, boolean, and idle-only shapes pass", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [
        {
          name: "a",
          type: "claude",
          tmux: "a",
          // idle-only is valid now (no slash/keys) — the auto-teardown carries it
          provision: { command: "claude", teardown: { idle: "30m" } },
        },
      ],
      topology: {},
      types: { claude: { teardown: { slash: "exit", idle: true } } },
    });
    expect(cfg.agents[0]?.provision?.teardown).toEqual({ idle: "30m" });
    expect(cfg.types?.claude?.teardown).toEqual({ slash: "exit", idle: true });
  });

  test("teardown.idle (FR-92): a bad duration is rejected, false is accepted", () => {
    const withIdle = (idle: unknown) => ({
      server: { port: 1 },
      agents: [
        { name: "a", type: "claude", tmux: "a", provision: { command: "c", teardown: { idle } } },
      ],
      topology: {},
    });
    expect(grab(() => validateStructure(withIdle("soon"))).path).toBe(
      "/agents/0/provision/teardown/idle",
    );
    expect(grab(() => validateStructure(withIdle("0h"))).path).toBe(
      "/agents/0/provision/teardown/idle",
    ); // non-positive
    expect(grab(() => validateStructure(withIdle(60))).path).toBe(
      "/agents/0/provision/teardown/idle",
    ); // a number is neither a duration string nor a boolean
    // idle:false is an explicit no-op — still a valid (if pointless) declaration
    expect(validateStructure(withIdle(false)).agents[0]?.provision?.teardown).toEqual({
      idle: false,
    });
  });

  test("teardown shapes are closed and need slash and/or keys (FR-64)", () => {
    const withTeardown = (teardown: unknown) => ({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", provision: { command: "c", teardown } }],
      topology: {},
    });
    expect(grab(() => validateStructure(withTeardown({}))).path).toBe(
      "/agents/0/provision/teardown",
    ); // neither slash nor keys
    expect(grab(() => validateStructure(withTeardown({ keys: [] }))).path).toBe(
      "/agents/0/provision/teardown",
    ); // empty keys is "neither"
    expect(grab(() => validateStructure(withTeardown({ slash: "exit", surprise: 1 }))).path).toBe(
      "/agents/0/provision/teardown/surprise",
    );
    expect(grab(() => validateStructure(withTeardown({ slash: "" }))).path).toBe(
      "/agents/0/provision/teardown/slash",
    );
    expect(grab(() => validateStructure(withTeardown({ slash: "exit", graceMs: -1 }))).path).toBe(
      "/agents/0/provision/teardown/graceMs",
    );
    expect(grab(() => validateStructure(withTeardown({ keys: ["C-c", ""] }))).path).toBe(
      "/agents/0/provision/teardown/keys/1",
    );
  });

  test("the types block is closed per entry (FR-64)", () => {
    const base = { server: { port: 1 }, agents: [], topology: {} };
    expect(
      grab(() => validateStructure({ ...base, types: { claude: { surprise: 1 } } })).path,
    ).toBe("/types/claude/surprise");
    expect(
      grab(() => validateStructure({ ...base, types: { claude: { teardown: {} } } })).path,
    ).toBe("/types/claude/teardown");
    expect(grab(() => validateStructure({ ...base, types: "claude" })).path).toBe("/types");
  });

  test("the tokens block (FR-103): valid shapes pass, empty block is allowed", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [],
      topology: {},
      types: {
        claude: {
          tokens: { enabled: true, sampleEvery: "60s", minuteSpan: "60m", maxThreshold: 1_000_000 },
        },
        auto: { tokens: {} }, // all fields fall back to runtime defaults
      },
    });
    expect(cfg.types?.claude?.tokens).toEqual({
      enabled: true,
      sampleEvery: "60s",
      minuteSpan: "60m",
      maxThreshold: 1_000_000,
    });
    expect(cfg.types?.auto?.tokens).toEqual({});
  });

  test("the tokens block is closed and typed (FR-103)", () => {
    const withTokens = (tokens: unknown) => ({
      server: { port: 1 },
      agents: [],
      topology: {},
      types: { claude: { tokens } },
    });
    expect(grab(() => validateStructure(withTokens({ surprise: 1 }))).path).toBe(
      "/types/claude/tokens/surprise",
    );
    expect(grab(() => validateStructure(withTokens({ enabled: "yes" }))).path).toBe(
      "/types/claude/tokens/enabled",
    );
    expect(grab(() => validateStructure(withTokens({ sampleEvery: "soon" }))).path).toBe(
      "/types/claude/tokens/sampleEvery",
    );
    expect(grab(() => validateStructure(withTokens({ minuteSpan: "0m" }))).path).toBe(
      "/types/claude/tokens/minuteSpan",
    ); // non-positive duration
    expect(grab(() => validateStructure(withTokens({ maxThreshold: 0 }))).path).toBe(
      "/types/claude/tokens/maxThreshold",
    );
    expect(grab(() => validateStructure(withTokens({ maxThreshold: 1.5 }))).path).toBe(
      "/types/claude/tokens/maxThreshold",
    );
  });

  test("commands on the agent and the type (FR-66): valid shapes pass", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [
        {
          name: "a",
          type: "claude",
          tmux: "a",
          commands: [{ slash: "usage", keys: "capture Escape" }],
        },
      ],
      topology: {},
      types: { claude: { commands: [{ slash: "clear" }, { slash: "compact" }] } },
    });
    expect(cfg.agents[0]?.commands).toEqual([{ slash: "usage", keys: "capture Escape" }]);
    expect(cfg.types?.claude?.commands).toEqual([{ slash: "clear" }, { slash: "compact" }]);
  });

  test("command shapes are closed; slash unique per list (FR-66)", () => {
    const withCommands = (commands: unknown) => ({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", commands }],
      topology: {},
    });
    expect(grab(() => validateStructure(withCommands([{ slash: "" }]))).path).toBe(
      "/agents/0/commands/0/slash",
    );
    expect(grab(() => validateStructure(withCommands([{ slash: "x", surprise: 1 }]))).path).toBe(
      "/agents/0/commands/0/surprise",
    );
    expect(grab(() => validateStructure(withCommands([{ slash: "x", esc: true }]))).path).toBe(
      "/agents/0/commands/0/esc",
    ); // T119: the old esc flag is GONE — an unknown field now
    expect(grab(() => validateStructure(withCommands([{ slash: "x" }, { slash: "x" }]))).path).toBe(
      "/agents/0/commands/1",
    );
  });

  test("command keys (T118/T119, FR-80): the DSL validates at load", () => {
    const withCommands = (commands: unknown) => ({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", commands }],
      topology: {},
    });
    const ok = validateStructure(
      withCommands([{ slash: "model", keys: "Down Enter capture Escape" }]),
    );
    expect(ok.agents[0]?.commands).toEqual([{ slash: "model", keys: "Down Enter capture Escape" }]);
    // a broken script is a CONFIG error, pointing at the keys field
    expect(
      grab(() => validateStructure(withCommands([{ slash: "x", keys: "capture capture" }]))).path,
    ).toBe("/agents/0/commands/0/keys");
    expect(grab(() => validateStructure(withCommands([{ slash: "x", keys: "" }]))).path).toBe(
      "/agents/0/commands/0/keys",
    );
  });

  test("raw-mode rule on the agent and the type (FR-88): valid shapes pass", () => {
    const cfg = validateStructure({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", raw: { keys: "C-b capture q" } }],
      topology: {},
      types: { claude: { raw: {} } }, // empty ⇒ the default stabilize-and-capture
    });
    expect(cfg.agents[0]?.raw).toEqual({ keys: "C-b capture q" });
    expect(cfg.types?.claude?.raw).toEqual({});
    // absent stays absent (the default rule, §14.2)
    const plain = validateStructure({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a" }],
      topology: {},
    });
    expect(plain.agents[0]?.raw).toBeUndefined();
  });

  test("raw shape is closed; keys is a key-DSL validated at load (FR-88/FR-80)", () => {
    const withRaw = (raw: unknown) => ({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", raw }],
      topology: {},
    });
    expect(grab(() => validateStructure(withRaw({ surprise: 1 }))).path).toBe(
      "/agents/0/raw/surprise",
    );
    expect(grab(() => validateStructure(withRaw({ keys: "" }))).path).toBe("/agents/0/raw/keys");
    expect(grab(() => validateStructure(withRaw({ keys: "capture capture" }))).path).toBe(
      "/agents/0/raw/keys",
    );
    // a broken type-level rule points at the type path
    const withTypeRaw = (raw: unknown) => ({
      server: { port: 1 },
      agents: [],
      topology: {},
      types: { claude: { raw } },
    });
    expect(grab(() => validateStructure(withTypeRaw({ keys: 7 }))).path).toBe(
      "/types/claude/raw/keys",
    );
  });

  test("agent.color (FR-73): optional hex color, closed shape", () => {
    const withColor = (color: unknown) => ({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", color }],
      topology: {},
    });
    expect(validateStructure(withColor("#ff8800")).agents[0]?.color).toBe("#ff8800");
    expect(validateStructure(withColor("#F80")).agents[0]?.color).toBe("#F80");
    const plain = validateStructure({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a" }],
      topology: {},
    });
    expect(plain.agents[0]?.color).toBeUndefined();
    expect(grab(() => validateStructure(withColor("red"))).path).toBe("/agents/0/color");
    expect(grab(() => validateStructure(withColor("#ff88"))).path).toBe("/agents/0/color");
    expect(grab(() => validateStructure(withColor(7))).path).toBe("/agents/0/color");
  });

  test("agent.title (FR-156): optional non-empty label, name untouched", () => {
    const withTitle = (title: unknown) => ({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", title }],
      topology: {},
    });
    const titled = validateStructure(withTitle("Researcher")).agents[0];
    expect(titled?.title).toBe("Researcher");
    expect(titled?.name).toBe("a"); // the label never becomes the identity
    const plain = validateStructure({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a" }],
      topology: {},
    });
    expect(plain.agents[0]?.title).toBeUndefined();
    expect(grab(() => validateStructure(withTitle(""))).path).toBe("/agents/0/title");
    expect(grab(() => validateStructure(withTitle(7))).path).toBe("/agents/0/title");
  });

  test("internal command names are reserved (FR-67): a config command cannot shadow them", () => {
    const withCommands = (commands: unknown) => ({
      server: { port: 1 },
      agents: [{ name: "a", type: "claude", tmux: "a", commands }],
      topology: {},
    });
    expect(() => validateStructure(withCommands([{ slash: "screenshot" }]))).toThrow(
      /reserved for an internal command/,
    );
    expect(
      grab(() =>
        validateStructure({
          server: { port: 1 },
          agents: [],
          topology: {},
          types: { claude: { commands: [{ slash: "screenshot" }] } },
        }),
      ).path,
    ).toBe("/types/claude/commands/0");
  });

  test("commandGrants structural shape (FR-94/FR-95): directed map with wildcards", () => {
    const withGrants = (commandGrants: unknown) => ({ ...validResolved(), commandGrants });
    const grants = { writer: { researcher: ["clear", "compact"] }, "*": { "*": ["*"] } };
    expect(validateStructure(withGrants(grants)).commandGrants).toEqual(grants);
    // absent ⇒ undefined (the §10.10 default: no agent→agent commands)
    expect(validateStructure(validResolved()).commandGrants).toBeUndefined();
    // the recipient map and command list must have the right shape
    expect(grab(() => validateStructure(withGrants({ writer: ["clear"] }))).path).toBe(
      "/commandGrants/writer",
    );
    expect(
      grab(() => validateStructure(withGrants({ writer: { researcher: "clear" } }))).path,
    ).toBe("/commandGrants/writer/researcher");
    expect(grab(() => validateStructure(withGrants({ writer: { researcher: [""] } }))).path).toBe(
      "/commandGrants/writer/researcher/0",
    );
    // a duplicate command in one list is fatal
    expect(
      grab(() => validateStructure(withGrants({ writer: { researcher: ["clear", "clear"] } })))
        .message,
    ).toMatch(/duplicate command "clear"/);
  });

  test("sessionGrants structural shape (FR-96/FR-97): directed map with wildcards", () => {
    const withGrants = (sessionGrants: unknown) => ({ ...validResolved(), sessionGrants });
    const grants = { writer: { researcher: ["restart", "stop"] }, "*": { "*": ["*"] } };
    expect(validateStructure(withGrants(grants)).sessionGrants).toEqual(grants);
    // absent ⇒ undefined (the §10.10 default: no agent→agent session control)
    expect(validateStructure(validResolved()).sessionGrants).toBeUndefined();
    // the recipient map and action list must have the right shape
    expect(grab(() => validateStructure(withGrants({ writer: ["restart"] }))).path).toBe(
      "/sessionGrants/writer",
    );
    expect(
      grab(() => validateStructure(withGrants({ writer: { researcher: "restart" } }))).path,
    ).toBe("/sessionGrants/writer/researcher");
    expect(grab(() => validateStructure(withGrants({ writer: { researcher: [""] } }))).path).toBe(
      "/sessionGrants/writer/researcher/0",
    );
    // a duplicate action in one list is fatal (structural — the action VALUE is
    // checked semantically in validate.ts, §7.5)
    expect(
      grab(() => validateStructure(withGrants({ writer: { researcher: ["stop", "stop"] } })))
        .message,
    ).toMatch(/duplicate action "stop"/);
  });

  test("rejects structural violations with a located error", () => {
    expect(() => validateStructure(42)).toThrow(ConfigError);
    expect(() => validateStructure({ agents: [], topology: {} })).toThrow(/server/);
    expect(grab(() => validateStructure({ server: {}, agents: [], topology: {} })).path).toBe(
      "/server/port",
    );
    expect(
      grab(() =>
        validateStructure({
          server: { port: 1 },
          agents: [{ type: "claude", tmux: "x" }],
          topology: {},
        }),
      ).path,
    ).toBe("/agents/0/name");
    expect(() => validateStructure({ server: { port: 70000 }, agents: [], topology: {} })).toThrow(
      /0\.\.65535/,
    );
  });

  test("topology must map nodes to string arrays", () => {
    expect(
      grab(() => validateStructure({ server: { port: 1 }, agents: [], topology: { a: "nope" } }))
        .path,
    ).toBe("/topology/a");
  });
});

describe("inline channel secrets forbidden (§7.3)", () => {
  test("an inline secret is fatal; an $env reference passes", () => {
    expect(() =>
      assertChannelSecretsAreEnvRefs({
        channels: [{ type: "telegram", token: "inline", bindOperator: "op" }],
      }),
    ).toThrow(ConfigError);
    expect(() =>
      assertChannelSecretsAreEnvRefs({
        channels: [{ type: "telegram", token: { $env: "T" }, bindOperator: "op" }],
      }),
    ).not.toThrow();
  });

  test("non-secret fields may be inline; an absent secret is fine", () => {
    expect(() =>
      assertChannelSecretsAreEnvRefs({
        channels: [{ type: "web", bindOperator: "op", defaultTarget: "a" }],
      }),
    ).not.toThrow();
  });

  test("webchat nests its secret: auth.password must be $env too (§12.2)", () => {
    expect(() =>
      assertChannelSecretsAreEnvRefs({
        channels: [{ type: "webchat", bindOperator: "op", auth: { password: "inline" } }],
      }),
    ).toThrow(/auth\.password.*\$env.*\(at \/channels\/0\/auth\/password\)/);
    expect(() =>
      assertChannelSecretsAreEnvRefs({
        channels: [
          { type: "webchat", bindOperator: "op", auth: { password: { $env: "WEB_PASS" } } },
        ],
      }),
    ).not.toThrow();
  });
});

describe("server.cadence (§7.1, NFR-10 — T41)", () => {
  const base = {
    server: { port: 1 },
    agents: [],
    topology: {},
  };

  test("accepts calibrated overrides", () => {
    const config = validateStructure({
      ...base,
      server: {
        port: 1,
        cadence: {
          outputPollMs: 50,
          downProbeMs: 500,
          routineRescanMs: 5000,
          idleTeardownSweepMs: 30000,
          livenessProbeMs: 3000,
          rendezvousSweepMs: 4000,
        },
      },
    });
    expect(config.server.cadence).toEqual({
      outputPollMs: 50,
      downProbeMs: 500,
      routineRescanMs: 5000,
      idleTeardownSweepMs: 30000,
      livenessProbeMs: 3000,
      rendezvousSweepMs: 4000,
    });
  });

  test("rejects zero, negatives, non-integers, and unknown fields", () => {
    const withCadence = (cadence: unknown) => ({ ...base, server: { port: 1, cadence } });
    expect(() => validateStructure(withCadence({ outputPollMs: 0 }))).toThrow(/positive/);
    expect(() => validateStructure(withCadence({ downProbeMs: -5 }))).toThrow();
    expect(() => validateStructure(withCadence({ routineTickMs: 1.5 }))).toThrow();
    expect(() => validateStructure(withCadence({ pollMs: 100 }))).toThrow(/unknown cadence/);
  });
});

describe("WIP limit config (§8.2, FR-104)", () => {
  const agent = (extra: Record<string, unknown>) => ({
    server: { port: 1 },
    agents: [{ name: "a", type: "claude", tmux: "a", ...extra }],
    topology: {},
  });

  test("server.wipLimit and agent.wipLimit are optional non-negative integers (0 = unlimited)", () => {
    const cfg = validateStructure({
      server: { port: 1, wipLimit: 5 },
      agents: [
        { name: "a", type: "claude", tmux: "a", wipLimit: 0 },
        { name: "b", type: "claude", tmux: "b" },
      ],
      topology: {},
    });
    expect(cfg.server.wipLimit).toBe(5);
    expect(cfg.agents[0]?.wipLimit).toBe(0);
    expect(cfg.agents[1]?.wipLimit).toBeUndefined();
  });

  test("rejects a negative or non-integer wipLimit", () => {
    expect(grab(() => validateStructure(agent({ wipLimit: -1 }))).path).toBe("/agents/0/wipLimit");
    expect(() => validateStructure(agent({ wipLimit: 1.5 }))).toThrow(/non-negative integer/);
    expect(
      grab(() => validateStructure({ ...agent({}), server: { port: 1, wipLimit: -2 } })).path,
    ).toBe("/server/wipLimit");
  });

  test("resolveWipLimit: agent override → server default → DEFAULT_WIP_LIMIT; 0 is preserved", () => {
    const a = (wipLimit?: number) => ({
      name: "a",
      type: "claude",
      tmux: "a",
      ...(wipLimit !== undefined ? { wipLimit } : {}),
    });
    expect(resolveWipLimit(a(7), { port: 1, mcp: true })).toBe(7); // agent wins
    expect(resolveWipLimit(a(), { port: 1, mcp: true, wipLimit: 4 })).toBe(4); // server default
    expect(resolveWipLimit(a(), { port: 1, mcp: true })).toBe(DEFAULT_WIP_LIMIT); // 3
    expect(resolveWipLimit(a(0), { port: 1, mcp: true, wipLimit: 4 })).toBe(0); // 0 not swallowed
    expect(DEFAULT_WIP_LIMIT).toBe(3);
  });
});

describe("rendezvous config (§8.2, FR-105)", () => {
  const withRz = (rendezvous: unknown) => ({
    server: { port: 1, rendezvous },
    agents: [],
    topology: {},
  });

  test("accepts a closed { enabled, window, maxAttempts } block", () => {
    const cfg = validateStructure(withRz({ enabled: false, window: "30s", maxAttempts: 5 }));
    expect(cfg.server.rendezvous).toEqual({ enabled: false, window: "30s", maxAttempts: 5 });
  });

  test("is optional and absent by default", () => {
    expect(
      validateStructure({ server: { port: 1 }, agents: [], topology: {} }).server.rendezvous,
    ).toBeUndefined();
  });

  test("rejects unknown fields, non-duration window, and non-positive maxAttempts", () => {
    expect(grab(() => validateStructure(withRz({ ttl: "15m" }))).path).toBe(
      "/server/rendezvous/ttl",
    );
    expect(() => validateStructure(withRz({ ttl: "15m" }))).toThrow(/unknown rendezvous field/);
    expect(grab(() => validateStructure(withRz({ window: "soon" }))).path).toBe(
      "/server/rendezvous/window",
    );
    expect(grab(() => validateStructure(withRz({ window: "0s" }))).path).toBe(
      "/server/rendezvous/window",
    );
    expect(grab(() => validateStructure(withRz({ enabled: "yes" }))).path).toBe(
      "/server/rendezvous/enabled",
    );
    expect(grab(() => validateStructure(withRz({ maxAttempts: 0 }))).path).toBe(
      "/server/rendezvous/maxAttempts",
    );
    expect(() => validateStructure(withRz({ maxAttempts: 0 }))).toThrow(/positive integer/);
    expect(grab(() => validateStructure(withRz({ maxAttempts: 1.5 }))).path).toBe(
      "/server/rendezvous/maxAttempts",
    );
  });

  test("resolveRendezvous: fills FR-105 defaults, honours overrides", () => {
    expect(resolveRendezvous({ port: 1, mcp: true })).toEqual({
      enabled: true,
      window: DEFAULT_RENDEZVOUS_WINDOW,
      maxAttempts: DEFAULT_RENDEZVOUS_MAX_ATTEMPTS,
    });
    expect(
      resolveRendezvous({ port: 1, mcp: true, rendezvous: { enabled: false, maxAttempts: 2 } }),
    ).toEqual({ enabled: false, window: DEFAULT_RENDEZVOUS_WINDOW, maxAttempts: 2 });
    expect(DEFAULT_RENDEZVOUS_WINDOW).toBe("15s");
    expect(DEFAULT_RENDEZVOUS_MAX_ATTEMPTS).toBe(8);
  });

  test("rejects zero rendezvousSweepMs like other cadences", () => {
    expect(() =>
      validateStructure({
        server: { port: 1, cadence: { rendezvousSweepMs: 0 } },
        agents: [],
        topology: {},
      }),
    ).toThrow(/positive/);
  });
});

describe("groups & tags structural shape (§15, FR-106/FR-107)", () => {
  const withGroups = (groups: unknown, agents: unknown[] = []) => ({
    server: { port: 1 },
    agents,
    topology: {},
    groups,
  });

  test("groups is an optional array of { name, parent? }; absent ⇒ undefined", () => {
    expect(
      validateStructure({ server: { port: 1 }, agents: [], topology: {} }).groups,
    ).toBeUndefined();
    const cfg = validateStructure(withGroups([{ name: "eng" }, { name: "devs", parent: "eng" }]));
    expect(cfg.groups).toEqual([{ name: "eng" }, { name: "devs", parent: "eng" }]);
  });

  test("an unknown group field is rejected with its path", () => {
    expect(grab(() => validateStructure(withGroups([{ name: "eng", surprise: 1 }]))).path).toBe(
      "/groups/0/surprise",
    );
  });

  test("a non-string / empty group name is rejected", () => {
    expect(grab(() => validateStructure(withGroups([{ name: "" }]))).path).toBe("/groups/0/name");
    expect(grab(() => validateStructure(withGroups([{ parent: "eng" }]))).path).toBe(
      "/groups/0/name",
    );
  });

  test("agent group is an optional non-empty string; tags dedup within an agent", () => {
    const cfg = validateStructure(
      withGroups(
        [{ name: "eng" }],
        [{ name: "a", type: "claude", tmux: "a", group: "eng", tags: ["it", "docs"] }],
      ),
    );
    expect(cfg.agents[0]?.group).toBe("eng");
    expect(cfg.agents[0]?.tags).toEqual(["it", "docs"]);
    // duplicate tag within one agent is fatal at the second occurrence
    expect(
      grab(() =>
        validateStructure(
          withGroups(
            [{ name: "eng" }],
            [{ name: "a", type: "claude", tmux: "a", tags: ["it", "it"] }],
          ),
        ),
      ).path,
    ).toBe("/agents/0/tags/1");
  });
});
