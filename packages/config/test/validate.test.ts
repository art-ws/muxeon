import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/error";
import type {
  AgentConfig,
  ChannelConfig,
  GroupConfig,
  MuxeonConfig,
  TopologyMap,
} from "../src/schema";
import { validateRules } from "../src/validate";

// A fully valid config (researcher↔writer↔operator wired; operator has an edge and
// a valid defaultTarget) — every §7.5 rule passes, no warnings.
function base(
  overrides: {
    agents?: AgentConfig[];
    topology?: TopologyMap;
    channels?: ChannelConfig[];
    groups?: GroupConfig[];
  } = {},
): MuxeonConfig {
  return {
    server: { port: 8080, mcp: true },
    agents: overrides.agents ?? [
      { name: "researcher", type: "claude", tmux: "researcher-session" },
      { name: "writer", type: "claude", tmux: "writer-session" },
    ],
    topology: overrides.topology ?? {
      researcher: ["writer", "operator"],
      writer: ["researcher"],
      operator: ["researcher"],
    },
    channels: overrides.channels ?? [
      { type: "telegram", bindOperator: "operator", defaultTarget: "researcher" },
    ],
    ...(overrides.groups !== undefined ? { groups: overrides.groups } : {}),
  };
}

const KNOWN = ["claude"];

describe("§7.5 fail-fast validation rules", () => {
  test("a fully valid config passes with no warnings", () => {
    expect(validateRules(base(), { knownAdapterTypes: KNOWN })).toEqual([]);
  });

  test("rule 2: duplicate agent names are fatal", () => {
    const config = base({
      agents: [
        { name: "dup", type: "claude", tmux: "a" },
        { name: "dup", type: "claude", tmux: "b" },
      ],
      topology: {},
      channels: [],
    });
    expect(() => validateRules(config)).toThrow(/duplicate agent name/);
  });

  test("rule 2: agent and operator names must be disjoint", () => {
    const config = base({
      agents: [{ name: "operator", type: "claude", tmux: "a" }],
      topology: {},
      channels: [{ type: "telegram", bindOperator: "operator" }],
    });
    expect(() => validateRules(config)).toThrow(/both an agent and an operator/);
  });

  test("rule 3: duplicate tmux queue keys are fatal", () => {
    const config = base({
      agents: [
        { name: "a", type: "claude", tmux: "shared" },
        { name: "b", type: "claude", tmux: "shared" },
      ],
      topology: {},
      channels: [],
    });
    expect(() => validateRules(config)).toThrow(/queue key "shared"/);
  });

  test("rule 3: an agent tmux colliding with an operator name is fatal", () => {
    const config = base({
      agents: [{ name: "a", type: "claude", tmux: "operator" }],
      topology: {},
      channels: [{ type: "telegram", bindOperator: "operator" }],
    });
    expect(() => validateRules(config)).toThrow(/queue key "operator"/);
  });

  test("rule 4: unknown adapter type is fatal only when types are injected", () => {
    const config = base({
      agents: [{ name: "a", type: "mystery", tmux: "a" }],
      topology: {},
      channels: [],
    });
    expect(() => validateRules(config, { knownAdapterTypes: KNOWN })).toThrow(
      /unknown type "mystery"/,
    );
    // Without injected types the rule is skipped (config can't import @muxeon/adapters):
    expect(() => validateRules(config)).not.toThrow();
  });

  test("rule 5: an operator bound by two channels is fatal", () => {
    const config = base({
      topology: { operator: ["researcher"], researcher: ["operator"] },
      channels: [
        { type: "telegram", bindOperator: "operator" },
        { type: "web", bindOperator: "operator" },
      ],
    });
    expect(() => validateRules(config, { knownAdapterTypes: KNOWN })).toThrow(
      /bound by more than one channel/,
    );
  });

  test("rule 1: topology referencing an unknown participant is fatal", () => {
    const config = base({ topology: { researcher: ["ghost"] }, channels: [] });
    expect(() => validateRules(config, { knownAdapterTypes: KNOWN })).toThrow(
      /unknown participant "ghost"/,
    );
  });

  test("rule 6: defaultTarget must be an existing agent", () => {
    const config = base({
      channels: [{ type: "telegram", bindOperator: "operator", defaultTarget: "nobody" }],
    });
    expect(() => validateRules(config, { knownAdapterTypes: KNOWN })).toThrow(
      /defaultTarget "nobody" is not an existing agent/,
    );
  });

  test("rule 6: defaultTarget must be a topology neighbor of the operator", () => {
    const config = base({
      // operator is only adjacent to researcher, not writer:
      topology: {
        operator: ["researcher"],
        researcher: ["operator", "writer"],
        writer: ["researcher"],
      },
      channels: [{ type: "telegram", bindOperator: "operator", defaultTarget: "writer" }],
    });
    expect(() => validateRules(config, { knownAdapterTypes: KNOWN })).toThrow(
      /not a topology neighbor/,
    );
  });

  test("rule 5: an operator without edges yields a warning, not an error", () => {
    const config = base({
      topology: { researcher: ["writer"], writer: ["researcher"] }, // operator absent → no edges
      channels: [{ type: "telegram", bindOperator: "operator" }], // no defaultTarget
    });
    const warnings = validateRules(config, { knownAdapterTypes: KNOWN });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/operator "operator" has no topology edges/);
  });

  test("errors are ConfigError instances with a location", () => {
    const config = base({
      agents: [{ name: "a", type: "mystery", tmux: "a" }],
      topology: {},
      channels: [],
    });
    try {
      validateRules(config, { knownAdapterTypes: KNOWN });
    } catch (caught) {
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).path).toBe("/agents/0/type");
      return;
    }
    throw new Error("expected a ConfigError");
  });
});

// --- rule 9: webchat channel (§12.2, T44) ------------------------------------

function webchatChannel(overrides: Record<string, unknown> = {}): ChannelConfig {
  return {
    type: "webchat",
    bindOperator: "operator",
    port: 8090,
    auth: { password: "resolved-secret" }, // already $env-resolved (§7.3)
    ...overrides,
  } as ChannelConfig;
}

describe("§7.5 rule 9: webchat channel (§12.2)", () => {
  const valid = (channel: ChannelConfig) =>
    validateRules(base({ channels: [channel] }), { knownAdapterTypes: KNOWN });

  test("a valid webchat channel passes (bind/upload/history optional)", () => {
    expect(
      valid(
        webchatChannel({
          bind: "0.0.0.0",
          upload: { maxBytes: 1024, mime: ["image/*", "text/*"] },
          history: { retain: { age: "90d", count: 10000 } },
        }),
      ),
    ).toEqual([]);
  });

  test.each([[undefined], ["8090"], [0], [65536], [80.5]])(
    "port must be an integer in 1..65535, got %p",
    (port) => {
      expect(() => valid(webchatChannel({ port }))).toThrow(/webchat requires a port/);
    },
  );

  test("port must differ from server.port (§8.1 surface is not extended)", () => {
    try {
      valid(webchatChannel({ port: 8080 })); // base server.port
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toContain("must differ from server.port");
      expect((error as ConfigError).path).toBe("/channels/0/port");
    }
  });

  test("auth.password is mandatory", () => {
    expect(() => valid(webchatChannel({ auth: undefined }))).toThrow(/auth\.password/);
    expect(() => valid(webchatChannel({ auth: {} }))).toThrow(/auth\.password/);
    expect(() => valid(webchatChannel({ auth: { password: "" } }))).toThrow(/auth\.password/);
  });

  test("auth is a closed shape with an optional session.ttl duration (FR-57)", () => {
    expect(valid(webchatChannel({ auth: { password: "secret", session: { ttl: "1d" } } }))).toEqual(
      [],
    );
    expect(() => valid(webchatChannel({ auth: { password: "secret", surprise: 1 } }))).toThrow(
      /unknown auth field "surprise"/,
    );
    expect(() => valid(webchatChannel({ auth: { password: "secret", session: "1d" } }))).toThrow(
      /expected an object/,
    );
    expect(() =>
      valid(webchatChannel({ auth: { password: "secret", session: { surprise: 1 } } })),
    ).toThrow(/unknown session field "surprise"/);
    expect(() =>
      valid(webchatChannel({ auth: { password: "secret", session: { ttl: "" } } })),
    ).toThrow(/session\.ttl must be a non-empty duration string/);
    expect(() =>
      valid(webchatChannel({ auth: { password: "secret", session: { ttl: 86400 } } })),
    ).toThrow(/session\.ttl must be a non-empty duration string/);
    // renew (FR-86) shares the grammar and the closed shape
    expect(
      valid(webchatChannel({ auth: { password: "secret", session: { ttl: "1d", renew: "12h" } } })),
    ).toEqual([]);
    expect(() =>
      valid(webchatChannel({ auth: { password: "secret", session: { renew: "" } } })),
    ).toThrow(/session\.renew must be a non-empty duration string/);
  });

  test("defaultTarget is forbidden — the recipient is explicit in the UI", () => {
    expect(() => valid(webchatChannel({ defaultTarget: "researcher" }))).toThrow(
      /does not use defaultTarget/,
    );
  });

  test("bind, when present, must be a non-empty string", () => {
    expect(() => valid(webchatChannel({ bind: "" }))).toThrow(/bind must be a non-empty string/);
  });

  // basePath (T120): "/"-led segments, no trailing slash, no dot-led segments.
  test.each([["/team"], ["/team/panel"], ["/v1.2/ui_x~y-z"]])(
    "basePath %p is a valid mount prefix",
    (basePath) => {
      expect(valid(webchatChannel({ basePath }))).toEqual([]);
    },
  );

  test.each([
    [""],
    ["/"],
    ["team"],
    ["/team/"],
    ["//team"],
    ["/te am"],
    ["/.."],
    ["/team/../etc"],
    ["/.hidden"],
    [42],
  ])("basePath %p is rejected with the /channels pointer", (basePath) => {
    try {
      valid(webchatChannel({ basePath }));
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toContain("basePath");
      expect((error as ConfigError).path).toBe("/channels/0/basePath");
    }
  });

  test("upload is a closed shape: maxBytes positive int, mime non-empty strings", () => {
    expect(() => valid(webchatChannel({ upload: { maxBytes: 0 } }))).toThrow(
      /maxBytes must be a positive integer/,
    );
    expect(() => valid(webchatChannel({ upload: { mime: ["image/*", ""] } }))).toThrow(
      /non-empty string/,
    );
    expect(() => valid(webchatChannel({ upload: { surprise: 1 } }))).toThrow(
      /unknown upload field "surprise"/,
    );
  });

  test("history is a closed shape: retain.age string, retain.count non-negative int", () => {
    expect(() => valid(webchatChannel({ history: { retain: { age: "" } } }))).toThrow(
      /non-empty string/,
    );
    expect(() => valid(webchatChannel({ history: { retain: { count: -1 } } }))).toThrow(
      /non-negative integer/,
    );
    expect(() => valid(webchatChannel({ history: { surprise: 1 } }))).toThrow(
      /unknown history field "surprise"/,
    );
  });

  test("non-webchat channels are untouched by rule 9", () => {
    expect(
      valid({ type: "telegram", bindOperator: "operator", defaultTarget: "researcher" }),
    ).toEqual([]);
  });
});

describe("§7.5 rule 10: agent→agent command grants (FR-94/FR-95)", () => {
  // researcher↔writer↔operator wired (base topology); writer carries two commands
  // so the catalog check (mergeCommands ∪ internal) has something to match.
  const withCommands = (): MuxeonConfig =>
    base({
      agents: [
        { name: "researcher", type: "claude", tmux: "r" },
        {
          name: "writer",
          type: "claude",
          tmux: "w",
          commands: [{ slash: "clear" }, { slash: "compact" }],
        },
      ],
    });
  const grant = (commandGrants: MuxeonConfig["commandGrants"]): MuxeonConfig => ({
    ...withCommands(),
    ...(commandGrants !== undefined ? { commandGrants } : {}),
  });
  const check = (config: MuxeonConfig) => validateRules(config, { knownAdapterTypes: KNOWN });

  test("a valid grant passes (edge exists, command in the recipient's catalog)", () => {
    expect(check(grant({ researcher: { writer: ["clear"] } }))).toEqual([]);
  });

  test("an internal command (FR-67) is grantable", () => {
    expect(check(grant({ researcher: { writer: ["screenshot"] } }))).toEqual([]);
  });

  test("an unknown sender is fatal", () => {
    expect(() => check(grant({ ghost: { writer: ["clear"] } }))).toThrow(
      /sender "ghost" is not an existing agent/,
    );
  });

  test("an operator cannot be a command sender (agent-plane only)", () => {
    expect(() => check(grant({ operator: { writer: ["clear"] } }))).toThrow(
      /sender "operator" is not an existing agent/,
    );
  });

  test("an unknown recipient is fatal", () => {
    expect(() => check(grant({ researcher: { ghost: ["clear"] } }))).toThrow(
      /recipient "ghost" is not an existing agent/,
    );
  });

  test("an explicit pair without a topology edge is fatal (a grant cannot widen the graph)", () => {
    const config: MuxeonConfig = {
      ...base({
        agents: [
          { name: "researcher", type: "claude", tmux: "r" },
          { name: "writer", type: "claude", tmux: "w", commands: [{ slash: "clear" }] },
        ],
        topology: { researcher: ["operator"], operator: ["researcher"] }, // no researcher↔writer
      }),
      commandGrants: { researcher: { writer: ["clear"] } },
    };
    expect(() => check(config)).toThrow(/no topology edge/);
  });

  test("a grant cannot target the sender itself", () => {
    expect(() => check(grant({ writer: { writer: ["clear"] } }))).toThrow(
      /cannot target the sender itself/,
    );
  });

  test("naming a command the recipient does not have is fatal", () => {
    expect(() => check(grant({ researcher: { writer: ["nope"] } }))).toThrow(
      /unknown command "nope"/,
    );
  });

  test('"*" wildcards skip the per-pair edge and per-command catalog checks', () => {
    expect(
      check(grant({ "*": { "*": ["*"] }, researcher: { "*": ["anything-unchecked"] } })),
    ).toEqual([]);
  });
});

describe("§7.5 rule 11: agent→agent session grants (FR-96/FR-97)", () => {
  // researcher↔writer↔operator wired; writer carries a provision command so the
  // start/restart/reload applicability check (FR-7/FR-96) has a startable recipient.
  const withProvision = (): MuxeonConfig =>
    base({
      agents: [
        { name: "researcher", type: "claude", tmux: "r" },
        { name: "writer", type: "claude", tmux: "w", provision: { command: "start-writer" } },
      ],
    });
  const grant = (sessionGrants: MuxeonConfig["sessionGrants"]): MuxeonConfig => ({
    ...withProvision(),
    ...(sessionGrants !== undefined ? { sessionGrants } : {}),
  });
  const check = (config: MuxeonConfig) => validateRules(config, { knownAdapterTypes: KNOWN });

  test("a valid grant passes (edge exists, recipient is startable)", () => {
    expect(check(grant({ researcher: { writer: ["restart", "stop"] } }))).toEqual([]);
  });

  test("stop/shutdown need no provision command — a provision-less recipient is stoppable", () => {
    const config: MuxeonConfig = {
      ...base({
        agents: [
          { name: "researcher", type: "claude", tmux: "r" },
          { name: "writer", type: "claude", tmux: "w" }, // no provision
        ],
      }),
      sessionGrants: { researcher: { writer: ["stop", "shutdown"] } },
    };
    expect(check(config)).toEqual([]);
  });

  test("an unknown sender is fatal", () => {
    expect(() => check(grant({ ghost: { writer: ["stop"] } }))).toThrow(
      /sender "ghost" is not an existing agent/,
    );
  });

  test("an operator cannot be a session-control sender (agent-plane only)", () => {
    expect(() => check(grant({ operator: { writer: ["stop"] } }))).toThrow(
      /sender "operator" is not an existing agent/,
    );
  });

  test("an unknown recipient is fatal", () => {
    expect(() => check(grant({ researcher: { ghost: ["stop"] } }))).toThrow(
      /recipient "ghost" is not an existing agent/,
    );
  });

  test("an explicit pair without a topology edge is fatal (a grant cannot widen the graph)", () => {
    const config: MuxeonConfig = {
      ...base({
        agents: [
          { name: "researcher", type: "claude", tmux: "r" },
          { name: "writer", type: "claude", tmux: "w", provision: { command: "start-writer" } },
        ],
        topology: { researcher: ["operator"], operator: ["researcher"] }, // no researcher↔writer
      }),
      sessionGrants: { researcher: { writer: ["stop"] } },
    };
    expect(() => check(config)).toThrow(/no topology edge/);
  });

  test("a grant cannot target the sender itself", () => {
    expect(() => check(grant({ writer: { writer: ["stop"] } }))).toThrow(
      /cannot target the sender itself/,
    );
  });

  test("an unknown action is fatal", () => {
    expect(() => check(grant({ researcher: { writer: ["nuke"] } }))).toThrow(
      /unknown action "nuke"/,
    );
  });

  test("start/restart/reload on a provision-less recipient is fatal", () => {
    const config: MuxeonConfig = {
      ...base({
        agents: [
          { name: "researcher", type: "claude", tmux: "r" },
          { name: "writer", type: "claude", tmux: "w" }, // no provision command
        ],
      }),
      sessionGrants: { researcher: { writer: ["restart"] } },
    };
    expect(() => check(config)).toThrow(/has no provision command/);
  });

  test('"*" wildcards skip the per-pair edge and per-applicability checks', () => {
    expect(check(grant({ "*": { "*": ["*"] }, researcher: { "*": ["restart"] } }))).toEqual([]);
  });
});

// §15 (FR-106/FR-107/§10.17): groups form an acyclic forest, tags are an implicit
// flat namespace, and agents ∪ operators ∪ groups ∪ tags share ONE disjoint
// namespace. Groups/tags are valid topology nodes (input-only broadcast targets).
describe("§15 groups & tags", () => {
  const KNOWN = ["claude"];
  const withGroups = (
    agents: AgentConfig[],
    groups: GroupConfig[],
    topology: TopologyMap = {},
  ): MuxeonConfig =>
    base({ agents, groups, topology, channels: [{ type: "telegram", bindOperator: "operator" }] });

  test("a valid group forest + tags + topology nodes passes", () => {
    const config = withGroups(
      [
        { name: "researcher", type: "claude", tmux: "r", group: "devs", tags: ["it"] },
        { name: "writer", type: "claude", tmux: "w", group: "eng", tags: ["it", "docs"] },
      ],
      [{ name: "eng" }, { name: "devs", parent: "eng" }],
      { operator: ["eng", "it", "researcher"] },
    );
    expect(validateRules(config, { knownAdapterTypes: KNOWN })).toEqual([]);
  });

  test("duplicate group name is fatal", () => {
    const config = withGroups(
      [{ name: "a", type: "claude", tmux: "a" }],
      [{ name: "eng" }, { name: "eng" }],
    );
    expect(() => validateRules(config)).toThrow(/duplicate group name "eng"/);
  });

  test("unknown parent is fatal", () => {
    const config = withGroups(
      [{ name: "a", type: "claude", tmux: "a" }],
      [{ name: "devs", parent: "ghost" }],
    );
    expect(() => validateRules(config)).toThrow(/unknown parent "ghost"/);
  });

  test("a group that is its own parent is fatal", () => {
    const config = withGroups(
      [{ name: "a", type: "claude", tmux: "a" }],
      [{ name: "eng", parent: "eng" }],
    );
    expect(() => validateRules(config)).toThrow(/cannot be its own parent/);
  });

  test("a cycle in the hierarchy is fatal", () => {
    const config = withGroups(
      [{ name: "a", type: "claude", tmux: "a" }],
      [
        { name: "x", parent: "y" },
        { name: "y", parent: "x" },
      ],
    );
    expect(() => validateRules(config)).toThrow(/cycle/);
  });

  test("an agent referencing an unknown group is fatal", () => {
    const config = withGroups(
      [{ name: "a", type: "claude", tmux: "a", group: "ghost" }],
      [{ name: "eng" }],
    );
    expect(() => validateRules(config)).toThrow(/references unknown group "ghost"/);
  });

  test("a group name colliding with an agent name is fatal (§10.17)", () => {
    const config = withGroups(
      [{ name: "researcher", type: "claude", tmux: "r" }],
      [{ name: "researcher" }],
    );
    expect(() => validateRules(config)).toThrow(/namespace must be disjoint/);
  });

  test("a tag name colliding with a group name is fatal (§10.17)", () => {
    const config = withGroups(
      [{ name: "a", type: "claude", tmux: "a", tags: ["eng"] }],
      [{ name: "eng" }],
    );
    expect(() => validateRules(config)).toThrow(/namespace must be disjoint/);
  });

  test("a tag name colliding with an operator name is fatal (§10.17)", () => {
    const config = withGroups([{ name: "a", type: "claude", tmux: "a", tags: ["operator"] }], []);
    expect(() => validateRules(config)).toThrow(/namespace must be disjoint/);
  });

  test("a topology reference to a tag no agent carries is an unknown node", () => {
    const config = withGroups([{ name: "a", type: "claude", tmux: "a" }], [], {
      operator: ["ghosttag"],
    });
    expect(() => validateRules(config)).toThrow(/unknown participant "ghosttag"/);
  });

  test("an empty declared group is a valid topology node", () => {
    const config = withGroups([{ name: "a", type: "claude", tmux: "a" }], [{ name: "empty" }], {
      operator: ["empty"],
    });
    expect(validateRules(config, { knownAdapterTypes: KNOWN })).toEqual([]);
  });
});
