import { describe, expect, test } from "bun:test";
import { type EnvSource, hasEnvKey, resolveEnv } from "../src/env";
import { ConfigError } from "../src/error";

const envOf =
  (map: Record<string, string>): EnvSource =>
  (name) =>
    map[name];

describe("$env resolution (§7.3, §10.7)", () => {
  test("resolves an $env marker and records its path as secret", () => {
    const result = resolveEnv({ token: { $env: "TOK" } }, envOf({ TOK: "s3cret" }));
    expect(result.value).toEqual({ token: "s3cret" });
    expect(result.secretPaths).toEqual(["/token"]);
  });

  test("resolves nested markers inside objects and arrays", () => {
    const result = resolveEnv(
      { channels: [{ token: { $env: "T" } }, { other: 1 }] },
      envOf({ T: "abc" }),
    );
    expect(result.value).toEqual({ channels: [{ token: "abc" }, { other: 1 }] });
    expect(result.secretPaths).toEqual(["/channels/0/token"]);
  });

  test("a missing variable is fatal and names the variable + location", () => {
    let error: unknown;
    try {
      resolveEnv({ a: { b: { $env: "MISSING" } } }, envOf({}));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("MISSING");
    expect((error as ConfigError).path).toBe("/a/b");
  });

  test("malformed markers are fatal (sibling key / non-string / empty name)", () => {
    expect(() => resolveEnv({ x: { $env: "A", extra: 1 } }, envOf({ A: "v" }))).toThrow(
      ConfigError,
    );
    expect(() => resolveEnv({ x: { $env: 123 } }, envOf({}))).toThrow(ConfigError);
    expect(() => resolveEnv({ x: { $env: "" } }, envOf({}))).toThrow(ConfigError);
  });

  test("non-$env values pass through unchanged with no secret paths", () => {
    const input = { n: 1, s: "x", b: true, arr: [1, 2], nested: { k: "v" } };
    const result = resolveEnv(input, envOf({}));
    expect(result.value).toEqual(input);
    expect(result.secretPaths).toEqual([]);
  });

  test("hasEnvKey detects env markers", () => {
    expect(hasEnvKey({ $env: "X" })).toBe(true);
    expect(hasEnvKey({ a: 1 })).toBe(false);
    expect(hasEnvKey("x")).toBe(false);
    expect(hasEnvKey(null)).toBe(false);
    expect(hasEnvKey([{ $env: "X" }])).toBe(false);
  });
});

import { secretValues } from "../src/env";

describe("secretValues (§8.7 boundary redaction input)", () => {
  test("extracts the resolved values at the reported secret paths", () => {
    const config = {
      channels: [{ type: "telegram", token: "TG-SECRET", bindOperator: "op" }],
      server: { port: 1 },
    };
    expect(secretValues(config, ["/channels/0/token"])).toEqual(["TG-SECRET"]);
  });

  test("tolerates stale pointers and non-string values", () => {
    expect(secretValues({ a: 5 }, ["/a", "/missing/deep"])).toEqual([]);
  });
});
