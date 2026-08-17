// The reaction catalog in the config (§19.2/§19.3, FR-161): a CLOSED top-level
// block, shape-checked in schema.ts and reference-checked in validate.ts. Every
// violation is fatal with its JSON-pointer path (FR-33) — an operator must not
// discover a typo as a silently missing reaction.

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/error";
import {
  type MuxeonConfig,
  REACTIONS_DEFAULT_RECENT_LIMIT,
  validateStructure,
} from "../src/schema";
import { validateRules } from "../src/validate";

const base = (reactions?: unknown): Record<string, unknown> => ({
  server: { port: 8080 },
  agents: [{ name: "muxeon", type: "claude", tmux: "muxeon" }],
  topology: { muxeon: ["shagin"], shagin: ["muxeon"] },
  channels: [{ type: "webchat", port: 8091, auth: { mode: "users" } }],
  users: [{ name: "shagin", auth: { password: "x" }, channels: { webchat: true } }],
  ...(reactions !== undefined ? { reactions } : {}),
});

const parse = (reactions?: unknown): MuxeonConfig => validateStructure(base(reactions));

const CATALOG = {
  categories: [{ name: "feedback", title: "Feedback" }, { name: "work" }],
  items: [
    { key: "ok", emoji: "👍", label: "Accepted", category: "feedback" },
    { key: "redo", emoji: "🔁", category: "work", agentMessage: "Redo it.", expectsReply: true },
    { key: "fire", emoji: "🔥" },
  ],
  picker: { recentLimit: 8 },
};

describe("shape (§19.2)", () => {
  test("a full catalog parses verbatim, optionals included", () => {
    const config = parse(CATALOG);
    expect(config.reactions?.items).toHaveLength(3);
    expect(config.reactions?.items[1]).toEqual({
      key: "redo",
      emoji: "🔁",
      category: "work",
      agentMessage: "Redo it.",
      expectsReply: true,
    });
    expect(config.reactions?.picker?.recentLimit).toBe(8);
    expect(config.reactions?.categories?.[1]).toEqual({ name: "work" }); // title optional
  });

  test("no block at all ⇒ reactions are simply absent (every old config is unchanged)", () => {
    expect(parse().reactions).toBeUndefined();
  });

  test("the default Recent length is exported for the server to apply", () => {
    expect(REACTIONS_DEFAULT_RECENT_LIMIT).toBe(12);
    expect(parse({ items: [{ key: "ok", emoji: "👍" }] }).reactions?.picker).toBeUndefined();
  });

  test("an unknown field is fatal — in the block, an item, a category or the picker", () => {
    const cases: [unknown, string][] = [
      [{ items: [], colour: "red" }, "/reactions/colour"],
      [{ items: [{ key: "ok", emoji: "👍", sound: "ping" }] }, "/reactions/items/0/sound"],
      [{ items: [], categories: [{ name: "a", icon: "x" }] }, "/reactions/categories/0/icon"],
      [{ items: [], picker: { limit: 3 } }, "/reactions/picker/limit"],
    ];
    for (const [reactions, path] of cases) {
      try {
        parse(reactions);
        throw new Error(`expected a ConfigError for ${path}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain("unknown");
        expect((error as ConfigError & { path?: string }).path).toBe(path);
      }
    }
  });

  test("items is required, and every key/emoji must be a non-empty string", () => {
    expect(() => parse({ categories: [] })).toThrow(ConfigError);
    expect(() => parse({ items: [{ emoji: "👍" }] })).toThrow(ConfigError);
    expect(() => parse({ items: [{ key: "ok" }] })).toThrow(ConfigError);
    expect(() => parse({ items: [{ key: "", emoji: "👍" }] })).toThrow(ConfigError);
  });

  test("duplicate keys and duplicate category names are fatal", () => {
    expect(() =>
      parse({
        items: [
          { key: "ok", emoji: "👍" },
          { key: "ok", emoji: "👌" },
        ],
      }),
    ).toThrow(/duplicate reaction key "ok"/);
    expect(() => parse({ categories: [{ name: "a" }, { name: "a" }], items: [] })).toThrow(
      /duplicate reaction category "a"/,
    );
  });

  test("the emoji must be exactly ONE grapheme — skin tones and VS16 count as one", () => {
    for (const emoji of ["👍", "👍🏽", "❤️", "⏸️"]) {
      expect(parse({ items: [{ key: "k", emoji }] }).reactions?.items[0]?.emoji).toBe(emoji);
    }
    expect(() => parse({ items: [{ key: "k", emoji: "👍👍" }] })).toThrow(/one grapheme/);
    expect(() => parse({ items: [{ key: "k", emoji: "ab" }] })).toThrow(/one grapheme/);
  });

  test("expectsReply must be boolean; recentLimit a non-negative integer", () => {
    expect(() => parse({ items: [{ key: "k", emoji: "👍", expectsReply: "yes" }] })).toThrow(
      ConfigError,
    );
    expect(() => parse({ items: [], picker: { recentLimit: -1 } })).toThrow(ConfigError);
    expect(() => parse({ items: [], picker: { recentLimit: 1.5 } })).toThrow(ConfigError);
    expect(parse({ items: [], picker: { recentLimit: 0 } }).reactions?.picker?.recentLimit).toBe(0);
  });
});

describe("references (§19.3, the §7.5 pass)", () => {
  const rules = (reactions: unknown): string[] =>
    validateRules(validateStructure(base(reactions)), { knownAdapterTypes: ["claude"] });

  test("a valid catalog raises no warnings", () => {
    expect(rules(CATALOG)).toEqual([]);
  });

  test("a category that was never declared is fatal, with the item's path", () => {
    try {
      rules({
        categories: [{ name: "work" }],
        items: [{ key: "ok", emoji: "👍", category: "nope" }],
      });
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('unknown category "nope"');
      expect((error as ConfigError & { path?: string }).path).toBe("/reactions/items/0/category");
    }
  });

  test("reaction keys are their OWN namespace — a key may equal a participant name", () => {
    // A key is never an address (§19.3), so "muxeon" as a key collides with nothing.
    expect(rules({ items: [{ key: "muxeon", emoji: "👍" }] })).toEqual([]);
  });
});
