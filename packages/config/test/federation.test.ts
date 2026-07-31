// §18.2/§18.3 (FR-137): the federation config shape and its fail-fast rules —
// imports/federation/exported, $env-only tokens (§10.7), the `@` ban (FQN
// separator), the six-set namespace (§10.17), unique export aliases, port
// distinctness and the zero-change guarantee without the blocks (FR-146).

import { describe, expect, test } from "bun:test";
import { loadConfig, validateRules, validateStructure } from "../src";

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

const IMPORTS = [{ name: "hq", url: "https://hq.example:8092", token: "tok-a" }];
const FEDERATION = { port: 8092, accept: [{ name: "branch", token: "tok-b" }] };

describe("federation config — shape (§18.2, FR-137)", () => {
  test("a full federated config survives structural validation", () => {
    const config = validateStructure({
      ...BASE,
      agents: [{ name: "dev", type: "claude", tmux: "dev-session", exported: true }],
      users: [{ name: "alex", exported: "alexander" }],
      imports: [{ name: "hq", url: "https://hq.example:8092", token: "tok", transit: false }],
      federation: {
        port: 8092,
        bind: "0.0.0.0",
        publishStatus: false,
        statusDebounceMs: 500,
        accept: [{ name: "branch", token: "tok2" }],
      },
      topology: { dev: ["hq"] },
    });
    expect(config.imports?.[0]?.transit).toBe(false);
    expect(config.federation?.publishStatus).toBe(false);
    expect(config.agents[0]?.exported).toBe(true);
    expect(config.users?.[0]?.exported).toBe("alexander");
  });

  test("unknown fields in imports/federation/accept are fatal", () => {
    expect(() =>
      validateStructure({
        ...BASE,
        imports: [{ name: "hq", url: "http://x", token: "t", ttl: 1 }],
      }),
    ).toThrow(/unknown import field "ttl"/);
    expect(() => validateStructure({ ...BASE, federation: { ...FEDERATION, tls: true } })).toThrow(
      /unknown federation field "tls"/,
    );
    expect(() =>
      validateStructure({
        ...BASE,
        federation: { port: 8092, accept: [{ name: "b", token: "t", transit: true }] },
      }),
    ).toThrow(/unknown accept field "transit"/);
  });

  test("exported must be true or a non-empty alias (§18.2)", () => {
    const agentWith = (exported: unknown) => ({
      ...BASE,
      agents: [{ name: "dev", type: "claude", tmux: "dev-session", exported }],
    });
    expect(() => validateStructure(agentWith(false))).toThrow(/exported must be true/);
    expect(() => validateStructure(agentWith(""))).toThrow(/exported must be true/);
    expect(() => validateStructure(agentWith(1))).toThrow(/exported must be true/);
  });

  test("exported on a group is rejected structurally (§18.2 — actors only)", () => {
    expect(() => validateStructure({ ...BASE, groups: [{ name: "eng", exported: true }] })).toThrow(
      /unknown group field "exported"/,
    );
  });

  test("statusDebounceMs must be a positive integer", () => {
    expect(() =>
      validateStructure({ ...BASE, federation: { ...FEDERATION, statusDebounceMs: 0 } }),
    ).toThrow(/statusDebounceMs must be a positive integer/);
  });
});

describe("federation tokens — $env only (§10.7, FR-137)", () => {
  test("an inline import token is rejected pre-resolution", () => {
    const text = JSON.stringify({
      ...BASE,
      imports: [{ name: "hq", url: "https://x", token: "inline-secret" }],
    });
    expect(() => loadConfig(text)).toThrow(
      /import token must be an \{ "\$env": \.\.\. \} reference/,
    );
  });

  test("an inline accept token is rejected pre-resolution", () => {
    const text = JSON.stringify({
      ...BASE,
      federation: { port: 8092, accept: [{ name: "b", token: "inline-secret" }] },
    });
    expect(() => loadConfig(text)).toThrow(
      /federation token must be an \{ "\$env": \.\.\. \} reference/,
    );
  });

  test("$env tokens resolve and are tracked as secrets", () => {
    const text = JSON.stringify({
      ...BASE,
      imports: [{ name: "hq", url: "https://x", token: { $env: "FED_TOK" } }],
      topology: {},
    });
    const result = loadConfig(text, { env: (name) => (name === "FED_TOK" ? "s3cret" : undefined) });
    expect(result.config.imports?.[0]?.token).toBe("s3cret");
    expect(result.secretPaths).toContain("/imports/0/token");
  });
});

describe("federation names — @ ban and the sixth namespace set (§18.3, §10.17)", () => {
  test("@ is rejected in agent, user, group, tag, import, accept and alias names", () => {
    expect(() =>
      check({ ...BASE, agents: [{ name: "dev@x", type: "claude", tmux: "s" }] }),
    ).toThrow(/reserved as the FQN separator/);
    expect(() => check({ ...BASE, users: [{ name: "a@b" }] })).toThrow(/FQN separator/);
    expect(() => check({ ...BASE, groups: [{ name: "g@x" }] })).toThrow(/FQN separator/);
    expect(() =>
      check({ ...BASE, agents: [{ name: "dev", type: "claude", tmux: "s", tags: ["t@x"] }] }),
    ).toThrow(/FQN separator/);
    expect(() =>
      check({ ...BASE, imports: [{ name: "hq@x", url: "https://x", token: "t" }] }),
    ).toThrow(/FQN separator/);
    expect(() =>
      check({ ...BASE, federation: { port: 8092, accept: [{ name: "b@x", token: "t" }] } }),
    ).toThrow(/FQN separator/);
    expect(() =>
      check({
        ...BASE,
        agents: [{ name: "dev", type: "claude", tmux: "s", exported: "d@x" }],
      }),
    ).toThrow(/FQN separator/);
  });

  test("an import name colliding with an agent/user/group/tag is a namespace error", () => {
    const imp = (name: string) => [{ name, url: "https://x", token: "t" }];
    expect(() => check({ ...BASE, imports: imp("dev") })).toThrow(/must be disjoint/);
    expect(() => check({ ...BASE, users: [{ name: "alex" }], imports: imp("alex") })).toThrow(
      /must be disjoint/,
    );
    expect(() => check({ ...BASE, groups: [{ name: "eng" }], imports: imp("eng") })).toThrow(
      /must be disjoint/,
    );
    expect(() =>
      check({
        ...BASE,
        agents: [{ name: "dev", type: "claude", tmux: "s", tags: ["infra"] }],
        imports: imp("infra"),
      }),
    ).toThrow(/must be disjoint/);
  });

  test("duplicate import and accept names are rejected", () => {
    expect(() =>
      check({
        ...BASE,
        imports: [
          { name: "hq", url: "https://x", token: "t" },
          { name: "hq", url: "https://y", token: "t" },
        ],
      }),
    ).toThrow(/duplicate import name "hq"/);
    expect(() =>
      check({
        ...BASE,
        federation: {
          port: 8092,
          accept: [
            { name: "b", token: "t" },
            { name: "b", token: "u" },
          ],
        },
      }),
    ).toThrow(/duplicate accept name "b"/);
  });

  test("export names are unique across exported actors (§18.3)", () => {
    expect(() =>
      check({
        ...BASE,
        agents: [
          { name: "dev", type: "claude", tmux: "s1", exported: "worker" },
          { name: "ops", type: "claude", tmux: "s2", exported: "worker" },
        ],
      }),
    ).toThrow(/export name "worker" is claimed by both/);
    // exported: true contributes the actor's own name to the export namespace.
    expect(() =>
      check({
        ...BASE,
        agents: [{ name: "dev", type: "claude", tmux: "s1", exported: true }],
        users: [{ name: "alex", exported: "dev" }],
      }),
    ).toThrow(/export name "dev" is claimed by both/);
    // ...but an alias may shadow an UNRELATED local name — export space is separate.
    expect(() =>
      check({
        ...BASE,
        agents: [
          { name: "dev", type: "claude", tmux: "s1" },
          { name: "ops", type: "claude", tmux: "s2", exported: "dev" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("federation topology and ports (§18.3)", () => {
  test("an import name is a valid topology node (§18.10-6)", () => {
    expect(() => check({ ...BASE, imports: IMPORTS, topology: { dev: ["hq"] } })).not.toThrow();
  });

  test("an FQN in topology gets the per-server error, not 'unknown participant'", () => {
    expect(() => check({ ...BASE, imports: IMPORTS, topology: { dev: ["alex@hq"] } })).toThrow(
      /federation edges are per-server/,
    );
  });

  test("federation.port must differ from server.port and channel ports", () => {
    expect(() =>
      check({ ...BASE, federation: { port: 8080, accept: [{ name: "b", token: "t" }] } }),
    ).toThrow(/must differ from server.port/);
    expect(() =>
      check({
        ...BASE,
        users: [{ name: "alex", auth: { passwordHash: "$x" }, channels: { web: true } }],
        channels: [{ name: "web", type: "webchat", port: 8091, auth: { mode: "users" } }],
        federation: { port: 8091, accept: [{ name: "b", token: "t" }] },
      }),
    ).toThrow(/must differ from channel "web" port/);
  });

  test('queue key "fed" is reserved once federation is configured (§18.5)', () => {
    expect(() =>
      check({
        ...BASE,
        agents: [{ name: "dev", type: "claude", tmux: "fed" }],
        imports: IMPORTS,
        topology: { dev: ["hq"] },
      }),
    ).toThrow(/reserved for federation link queues/);
    // ...but stays legal without the blocks (FR-146 compatibility).
    expect(() =>
      check({ ...BASE, agents: [{ name: "dev", type: "claude", tmux: "fed" }] }),
    ).not.toThrow();
  });
});

describe("federation warnings and compatibility (§18.2, §18.8, FR-146)", () => {
  test("http:// import warns; unknown scheme is fatal", () => {
    expect(
      check({
        ...BASE,
        imports: [{ name: "hq", url: "http://127.0.0.1:8092", token: "t" }],
      }),
    ).toContain('import "hq" uses plain http:// — acceptable for local testing only (§18.8)');
    expect(() => check({ ...BASE, imports: [{ name: "hq", url: "ftp://x", token: "t" }] })).toThrow(
      /url must be http\(s\):\/\//,
    );
  });

  test("an empty accept list warns — the listener admits nobody", () => {
    expect(check({ ...BASE, federation: { port: 8092, accept: [] } })).toContain(
      "federation.accept is empty — the link listener admits nobody (§18.2)",
    );
  });

  test("a config without imports/federation validates exactly as before (FR-146)", () => {
    expect(check(BASE)).toEqual([]);
  });
});

describe("relay mode config (§18.11, FR-152)", () => {
  test("publish and relay parse as booleans, default absent", () => {
    const config = validateStructure({
      ...BASE,
      imports: [{ name: "c", url: "https://hub.example:8092", token: "t", publish: true }],
      federation: { port: 8092, accept: [{ name: "a", token: "t2", relay: true }] },
    });
    expect(config.imports?.[0]?.publish).toBe(true);
    expect(config.federation?.accept[0]?.relay).toBe(true);
    const plain = validateStructure({ ...BASE, imports: IMPORTS, federation: FEDERATION });
    expect(plain.imports?.[0]?.publish).toBeUndefined();
    expect(plain.federation?.accept[0]?.relay).toBeUndefined();
  });

  test("a relay accept name joins the shared namespace; a plain accept stays out (§18.11.4)", () => {
    const withAccept = (accept: object) => ({
      ...BASE,
      federation: { port: 8092, accept: [accept] },
    });
    // Collision with an agent: fatal for relay, legal for a plain accept (compat).
    expect(() => check(withAccept({ name: "dev", token: "t", relay: true }))).toThrow(
      /must be disjoint/,
    );
    expect(() => check(withAccept({ name: "dev", token: "t" }))).not.toThrow();
    // Collision with an import: link names share one namespace.
    expect(() =>
      check({
        ...BASE,
        imports: IMPORTS,
        federation: { port: 8092, accept: [{ name: "hq", token: "t", relay: true }] },
      }),
    ).toThrow(/collides with an import/);
  });

  test("a relay accept is a topology node; a plain accept is not (§18.11.3/FR-154)", () => {
    const config = (relay: boolean) => ({
      ...BASE,
      federation: { port: 8092, accept: [{ name: "a", token: "t", ...(relay ? { relay } : {}) }] },
      topology: { dev: ["a"] },
    });
    expect(() => check(config(true))).not.toThrow();
    expect(() => check(config(false))).toThrow(/unknown participant/);
  });

  test("publish with nothing to publish warns (§18.11.1)", () => {
    const importsWith = (extra: object[] = []) => [
      { name: "c", url: "https://hub.example:8092", token: "t", publish: true },
      ...extra,
    ];
    expect(check({ ...BASE, imports: importsWith() })).toContain(
      'import "c" sets publish with no exported actors and no transit branches — nothing to publish (§18.11.1)',
    );
    // An exported actor is content...
    expect(
      check({
        ...BASE,
        agents: [{ name: "dev", type: "claude", tmux: "s", exported: true }],
        imports: importsWith(),
      }),
    ).toEqual([]);
    // ...and so is ANOTHER import's transit branch (the published link's own
    // branch would only bounce off the hub's cycle guard).
    expect(
      check({
        ...BASE,
        imports: importsWith([{ name: "d", url: "https://d.example:8092", token: "t2" }]),
      }),
    ).toEqual([]);
  });
});
