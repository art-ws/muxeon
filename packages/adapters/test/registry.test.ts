import { describe, expect, test } from "bun:test";
import { createClaudeAdapter } from "../src/claude";
import { AdapterRegistry, BASELINE_ADAPTER_TYPES, createDefaultRegistry } from "../src/registry";

describe("adapter registry (type → singleton, §8.2/§8.3)", () => {
  test("get/has/types resolve the registered adapters (claude + codex + auto)", () => {
    const registry = createDefaultRegistry({ stateDir: "/state" });
    for (const type of ["claude", "codex", "auto"]) {
      expect(registry.has(type)).toBe(true);
      expect(registry.get(type).type).toBe(type);
    }
    expect(registry.types()).toEqual(["auto", "claude", "codex"]); // sorted
  });

  test("an unknown type throws (config catches it first, T05)", () => {
    const registry = createDefaultRegistry({ stateDir: "/state" });
    expect(registry.has("mystery")).toBe(false);
    expect(() => registry.get("mystery")).toThrow();
  });

  test("duplicate adapter types are rejected", () => {
    const adapter = createClaudeAdapter({ stateDir: "/s" });
    expect(() => new AdapterRegistry([adapter, adapter])).toThrow();
  });

  test("BASELINE_ADAPTER_TYPES lists the built-in types for config validation", () => {
    expect(BASELINE_ADAPTER_TYPES).toContain("claude");
    expect(BASELINE_ADAPTER_TYPES).toContain("codex");
    expect(BASELINE_ADAPTER_TYPES).toContain("auto");
  });
});
