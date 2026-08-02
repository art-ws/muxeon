// §17.2/§17.3 (FR-121/FR-122/FR-125): the `users[]` shape and its fail-fast rules —
// the five-set namespace (§10.17), queue-key disjointness (§5.3), the password
// block, the channel bindings and the two mutually exclusive webchat modes.

import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, validateRules, validateStructure } from "../src";

const BASE = {
  server: { port: 8080, mcp: false },
  agents: [{ name: "dev", type: "claude", tmux: "dev-session" }],
  topology: {},
  channels: [],
};

/** Structural + semantic validation of a whole config (the load pipeline's core). */
function check(config: unknown): string[] {
  return validateRules(validateStructure(config));
}

const webchatUsers = (extra: Record<string, unknown> = {}) => ({
  name: "web",
  type: "webchat",
  port: 8090,
  auth: { mode: "users" },
  ...extra,
});

describe("users[] — shape (§17.2, FR-121)", () => {
  test("a full user survives structural validation", () => {
    const config = validateStructure({
      ...BASE,
      groups: [{ name: "managers" }],
      users: [
        {
          name: "alex",
          title: "Alexander",
          color: "#4488ff",
          group: "managers",
          tags: ["leadership"],
          role: "admin",
          auth: { password: "secret" },
          channels: { web: true, "tg-main": { alias: "alex_tg" } },
        },
      ],
      channels: [webchatUsers(), { name: "tg-main", type: "telegram" }],
      topology: { alex: ["dev"] },
    });
    expect(config.users?.[0]?.role).toBe("admin");
    expect(config.users?.[0]?.channels?.["tg-main"]).toEqual({ alias: "alex_tg" });
  });

  test("the display label (FR-156) is `title` — the old `displayName` is now unknown", () => {
    expect(validateStructure({ ...BASE, users: [{ name: "alex", title: "Alexander" }] }).users?.[0])
      .toEqual({ name: "alex", title: "Alexander" });
    // one field for agents and users (§7.1): the pre-FR-156 spelling fails fast
    // rather than being silently ignored — a label that does not show is a bug.
    expect(() =>
      validateStructure({ ...BASE, users: [{ name: "alex", displayName: "Alexander" }] }),
    ).toThrow(/unknown user field "displayName"/);
    expect(() => validateStructure({ ...BASE, users: [{ name: "alex", title: "" }] })).toThrow(
      ConfigError,
    );
  });

  test("an unknown field is a fatal config error", () => {
    expect(() => validateStructure({ ...BASE, users: [{ name: "alex", admin: true }] })).toThrow(
      /unknown user field "admin"/,
    );
  });

  test("role must be admin | user", () => {
    expect(() => validateStructure({ ...BASE, users: [{ name: "alex", role: "root" }] })).toThrow(
      /role must be one of admin\/user/,
    );
  });

  test("auth requires EXACTLY one of password | passwordHash (FR-122)", () => {
    const withAuth = (auth: unknown) => ({ ...BASE, users: [{ name: "alex", auth }] });
    expect(() => validateStructure(withAuth({}))).toThrow(/exactly one of password/);
    expect(() =>
      validateStructure(withAuth({ password: "a", passwordHash: "$argon2id$x" })),
    ).toThrow(/exactly one of password/);
    expect(validateStructure(withAuth({ passwordHash: "$argon2id$x" })).users?.[0]?.auth).toEqual({
      passwordHash: "$argon2id$x",
    });
  });
});

describe("users[] — namespace and queue keys (§17.3, §10.17)", () => {
  test("duplicate user names are rejected", () => {
    expect(() => check({ ...BASE, users: [{ name: "alex" }, { name: "alex" }] })).toThrow(
      /duplicate user name "alex"/,
    );
  });

  test("a user name colliding with an agent's tmux session is a queue-key collision (§5.3)", () => {
    expect(() => check({ ...BASE, users: [{ name: "dev-session" }] })).toThrow(/queue key/);
  });

  test("a user colliding with a group is a namespace collision (§10.17)", () => {
    expect(() =>
      check({ ...BASE, groups: [{ name: "managers" }], users: [{ name: "managers" }] }),
    ).toThrow(/must be disjoint \(§10\.17\)/);
  });

  test("a user colliding with a tag is a namespace collision (§10.17)", () => {
    expect(() =>
      check({
        ...BASE,
        agents: [{ name: "dev", type: "claude", tmux: "dev-session", tags: ["ops"] }],
        users: [{ name: "ops" }],
      }),
    ).toThrow(/must be disjoint \(§10\.17\)/);
  });

  test("a user is a valid topology node (§17.1, FR-123)", () => {
    expect(() =>
      check({ ...BASE, users: [{ name: "alex" }], topology: { alex: ["dev"] } }),
    ).not.toThrow();
  });

  test("a user's group must be declared (FR-130)", () => {
    expect(() => check({ ...BASE, users: [{ name: "alex", group: "ghosts" }] })).toThrow(
      /unknown group "ghosts"/,
    );
  });

  test("a user with no edges is a warning, not an error (self-chat still works)", () => {
    expect(check({ ...BASE, users: [{ name: "alex" }] })).toContain(
      'user "alex" has no topology edges — only their own self-chat works (§17.3)',
    );
  });
});

describe("channel bindings (§17.3, FR-125)", () => {
  const config = (users: unknown[], channels: unknown[] = [webchatUsers()]) => ({
    ...BASE,
    users,
    channels,
    topology: {},
  });

  test("binding an undeclared channel is fatal", () => {
    expect(() =>
      check(config([{ name: "alex", auth: { password: "x" }, channels: { nope: true } }])),
    ).toThrow(/binds unknown channel "nope"/);
  });

  test("a webchat binding must be `true` — the login IS the identity", () => {
    expect(() =>
      check(config([{ name: "alex", auth: { password: "x" }, channels: { web: { alias: "a" } } }])),
    ).toThrow(/must be true/);
  });

  test("a telegram binding requires an alias", () => {
    expect(() =>
      check(
        config(
          [{ name: "alex", channels: { tg: true } }],
          [{ name: "tg", type: "telegram", bindOperator: "op" }],
        ),
      ),
    ).toThrow(/requires an alias/);
  });

  test("two users cannot share one alias in a channel (§10.21)", () => {
    expect(() =>
      check(
        config(
          [
            { name: "alex", channels: { tg: { alias: "same" } } },
            { name: "kim", channels: { tg: { alias: "same" } } },
          ],
          [{ name: "tg", type: "telegram" }],
        ),
      ),
    ).toThrow(/is claimed by both/);
  });

  test("channel names must be unique — two telegram bots need explicit names", () => {
    expect(() =>
      check({ ...BASE, channels: [{ type: "telegram" }, { type: "telegram" }] }),
    ).toThrow(/duplicate channel name "telegram"/);
  });

  test("a webchat-bound user without auth is fatal (FR-122)", () => {
    expect(() => check(config([{ name: "alex", channels: { web: true } }]))).toThrow(
      /requires auth \(§17\.2\)/,
    );
  });
});

describe("webchat identity modes (§17.3)", () => {
  test('auth.mode:"users" and bindOperator are mutually exclusive', () => {
    expect(() => check({ ...BASE, channels: [webchatUsers({ bindOperator: "op" })] })).toThrow(
      /mutually exclusive/,
    );
  });

  test('auth.mode:"users" takes no channel password', () => {
    expect(() =>
      check({ ...BASE, channels: [webchatUsers({ auth: { mode: "users", password: "x" } })] }),
    ).toThrow(/takes no channel password/);
  });

  test("legacy webchat still requires bindOperator + auth.password (§12.2)", () => {
    expect(() => check({ ...BASE, channels: [{ type: "webchat", port: 8090 }] })).toThrow(
      /either bindOperator \(legacy\) or auth\.mode/,
    );
  });

  test("a users-mode panel with no bound user warns (nobody can log in)", () => {
    expect(check({ ...BASE, channels: [webchatUsers()] })).toContain(
      'webchat channel "web" runs in users mode with no user bound to it — nobody can log in (§17.3)',
    );
  });

  test("defaultTarget does not apply in users mode (§17.6)", () => {
    expect(() =>
      check({
        ...BASE,
        channels: [{ name: "tg", type: "telegram", defaultTarget: "dev" }],
      }),
    ).toThrow(/defaultTarget does not apply in users mode/);
  });

  test("a channel type without per-user identity still requires bindOperator", () => {
    expect(() => check({ ...BASE, channels: [{ type: "web", port: 9000 }] })).toThrow(
      /requires bindOperator/,
    );
  });
});

describe("passwords and deprecation warnings (§17.2, FR-122/FR-132)", () => {
  test("an inline literal password is allowed but warns (§10.7 point relaxation)", () => {
    const { warnings } = loadConfig(
      JSON.stringify({
        ...BASE,
        users: [{ name: "alex", auth: { password: "hunter2" }, channels: { web: true } }],
        channels: [webchatUsers()],
      }),
    );
    expect(warnings).toContain(
      'user "alex" has an inline auth.password — prefer { "$env": ... } or passwordHash (§17.2)',
    );
  });

  test("an $env password resolves and does NOT warn", () => {
    const { config, warnings } = loadConfig(
      JSON.stringify({
        ...BASE,
        users: [
          {
            name: "alex",
            auth: { password: { $env: "TEAMAI_ALEX" } },
            channels: { web: true },
          },
        ],
        channels: [webchatUsers()],
      }),
      { env: (name) => (name === "TEAMAI_ALEX" ? "from-env" : undefined) },
    );
    expect(config.users?.[0]?.auth?.password).toBe("from-env");
    expect(warnings.some((w) => w.includes("inline auth.password"))).toBe(false);
  });

  test("bindOperator alongside users[] is deprecated (FR-132)", () => {
    const warnings = check({
      ...BASE,
      users: [{ name: "alex" }],
      channels: [{ type: "telegram", bindOperator: "op" }],
      topology: { op: ["dev"] },
    });
    expect(warnings.some((w) => w.includes("bindOperator is deprecated by users[]"))).toBe(true);
  });

  test("a config without users[] behaves exactly as before (FR-132 regression guard)", () => {
    expect(() =>
      check({
        ...BASE,
        channels: [{ type: "telegram", bindOperator: "op" }],
        topology: { op: ["dev"] },
      }),
    ).not.toThrow();
  });
});

describe("presenceTtl (§17.5, FR-133)", () => {
  test("it takes the §7.1 duration grammar", () => {
    expect(
      validateStructure({ ...BASE, server: { ...BASE.server, presenceTtl: "30m" } }).server
        .presenceTtl,
    ).toBe("30m");
    expect(() =>
      validateStructure({ ...BASE, server: { ...BASE.server, presenceTtl: "soon" } }),
    ).toThrow(ConfigError);
  });
});
