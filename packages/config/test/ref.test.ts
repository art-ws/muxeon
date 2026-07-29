import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/error";
import { loadConfig } from "../src/load";
import { type ResolveRefOptions, resolveRefs } from "../src/ref";

const BASE = "/cfg/teamai.config.json"; // dirname → /cfg

// In-memory file reader keyed by absolute path (avoids touching the real fs).
function memReader(files: Record<string, unknown>): (path: string) => string {
  return (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
    return JSON.stringify(files[path]);
  };
}

function opts(files: Record<string, unknown>): ResolveRefOptions {
  return { baseFile: BASE, readFile: memReader(files) };
}

describe("$ref decomposition (§7.2, §10.6, FR-29/FR-30)", () => {
  test("resolve($ref) ≡ the equivalent monolith", () => {
    const monolith = {
      server: { port: 8080, mcp: true },
      agents: [
        { name: "r", type: "claude", tmux: "r" },
        { name: "w", type: "claude", tmux: "w" },
      ],
      topology: { r: ["w"], w: ["r"] },
      channels: [],
    };
    const entry = {
      server: { $ref: "./server.json" }, // whole file
      agents: [{ $ref: "./agents/researcher.json" }, { $ref: "./agents.json#/writer" }], // file + pointer
      topology: { r: ["w"], w: ["r"] },
      channels: [],
    };
    const files = {
      "/cfg/server.json": { port: 8080, mcp: true },
      "/cfg/agents/researcher.json": { name: "r", type: "claude", tmux: "r" },
      "/cfg/agents.json": { writer: { name: "w", type: "claude", tmux: "w" } },
    };
    expect(resolveRefs(entry, opts(files))).toEqual(monolith);
  });

  test("a monolith with no $ref is returned unchanged (no base file needed)", () => {
    const monolith = {
      server: { port: 1 },
      agents: [],
      topology: {},
      nested: { a: [1, 2, { b: "c" }] },
    };
    expect(resolveRefs(monolith)).toEqual(monolith);
  });

  test("relative paths resolve against the referencing file, not the entry", () => {
    const entry = { x: { $ref: "./sub/a.json" } };
    const files = {
      "/cfg/sub/a.json": { fromA: { $ref: "./b.json" } }, // ./b.json is relative to /cfg/sub
      "/cfg/sub/b.json": { value: 1 },
    };
    expect(resolveRefs(entry, opts(files))).toEqual({ x: { fromA: { value: 1 } } });
  });

  test("a $ref with sibling keys is fatal (strict substitution, no merge §7.2)", () => {
    expect(() =>
      resolveRefs({ x: { $ref: "./a.json", extra: 1 } }, opts({ "/cfg/a.json": {} })),
    ).toThrow(/sibling keys/);
  });

  test("a $ref must reference a file (bare #pointer is fatal)", () => {
    expect(() => resolveRefs({ x: { $ref: "#/foo" } }, opts({}))).toThrow(
      /must reference a local file/,
    );
  });

  test("a $ref without a known base file is fatal", () => {
    expect(() => resolveRefs({ x: { $ref: "./a.json" } })).toThrow(ConfigError);
  });

  test("an unreadable $ref is fatal and names the location", () => {
    let error: unknown;
    try {
      resolveRefs({ agents: [{ $ref: "./missing.json" }] }, opts({}));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toMatch(/cannot read \$ref/);
    expect((error as ConfigError).path).toBe("/agents/0");
  });

  test("a $ref pointer to a missing node is fatal", () => {
    expect(() =>
      resolveRefs({ x: { $ref: "./a.json#/nope" } }, opts({ "/cfg/a.json": { other: 1 } })),
    ).toThrow(/missing node/);
  });

  test("a circular $ref is fatal", () => {
    const files = {
      "/cfg/a.json": { $ref: "./b.json" },
      "/cfg/b.json": { $ref: "./a.json" },
    };
    expect(() => resolveRefs({ $ref: "./a.json" }, opts(files))).toThrow(/circular \$ref/);
  });

  test("$env inside a referenced file is expanded (pipeline order $ref → $env)", () => {
    const entry = JSON.stringify({
      server: { port: 1 },
      agents: [],
      topology: {},
      channels: [{ $ref: "./telegram.json" }],
    });
    const files = {
      "/cfg/telegram.json": { type: "telegram", token: { $env: "TG" }, bindOperator: "operator" },
    };
    const { config, secretPaths } = loadConfig(entry, {
      baseFile: BASE,
      readFile: memReader(files),
      env: () => "secret-token",
    });
    expect(config.channels[0]?.token).toBe("secret-token");
    expect(secretPaths).toEqual(["/channels/0/token"]);
  });
});
