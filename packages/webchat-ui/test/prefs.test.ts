// UI preference persistence (T98, FR-72) — the boolean switches (sidebar
// collapsed, auto-scroll) behind loadPref/savePref. DOM-free.

import { describe, expect, test } from "bun:test";
import { NO_FILTER } from "../src/agent-filter";
import {
  loadAgentFilter,
  loadExpandedGroups,
  loadPref,
  saveAgentFilter,
  saveExpandedGroups,
  savePref,
} from "../src/prefs";

function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("prefs (FR-72)", () => {
  test("round-trips a saved value, keyed per pref", () => {
    const storage = memoryStorage();
    savePref("collapsed", true, storage);
    savePref("follow", false, storage);
    savePref("transport", false, storage); // T115: the sidebar Transport entry
    expect(loadPref("collapsed", false, storage)).toBe(true);
    expect(loadPref("follow", true, storage)).toBe(false);
    expect(loadPref("transport", true, storage)).toBe(false);
    expect(Object.keys(storage.data).sort()).toEqual([
      "muxeon-pref:collapsed",
      "muxeon-pref:follow",
      "muxeon-pref:transport",
    ]);
  });

  test("a missing key yields the given default", () => {
    const storage = memoryStorage();
    expect(loadPref("collapsed", false, storage)).toBe(false);
    expect(loadPref("collapsed", true, storage)).toBe(true);
  });

  test("junk in storage falls back to the default", () => {
    const storage = memoryStorage({ "muxeon-pref:follow": "maybe" });
    expect(loadPref("follow", true, storage)).toBe(true);
    expect(loadPref("follow", false, storage)).toBe(false);
  });

  test("a throwing storage degrades silently to the default", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
    };
    expect(loadPref("collapsed", true, broken)).toBe(true);
    expect(() => savePref("collapsed", false, broken)).not.toThrow();
  });

  test("the Tags-section collapse (§15) rides the same BoolPref discipline", () => {
    const storage = memoryStorage();
    savePref("tags-collapsed", true, storage);
    expect(loadPref("tags-collapsed", false, storage)).toBe(true);
    expect(storage.data["muxeon-pref:tags-collapsed"]).toBe("true");
  });
});

describe("expanded-groups pref (§15)", () => {
  test("round-trips the set of expanded group names as a sorted JSON array", () => {
    const storage = memoryStorage();
    saveExpandedGroups(new Set(["eng", "backend"]), storage);
    expect(storage.data["muxeon-pref:tree-expanded"]).toBe('["backend","eng"]');
    expect([...(loadExpandedGroups(storage) ?? [])].sort()).toEqual(["backend", "eng"]);
  });

  test("an absent key ⇒ undefined (treat every group as expanded)", () => {
    expect(loadExpandedGroups(memoryStorage())).toBeUndefined();
  });

  test("a fully collapsed tree persists the empty set (NOT undefined)", () => {
    const storage = memoryStorage();
    saveExpandedGroups(new Set(), storage);
    expect(loadExpandedGroups(storage)).toEqual(new Set());
  });

  test("junk JSON and a non-array falls back to undefined", () => {
    expect(
      loadExpandedGroups(memoryStorage({ "muxeon-pref:tree-expanded": "not json" })),
    ).toBeUndefined();
    expect(
      loadExpandedGroups(memoryStorage({ "muxeon-pref:tree-expanded": '{"a":1}' })),
    ).toBeUndefined();
    expect(
      loadExpandedGroups(memoryStorage({ "muxeon-pref:tree-expanded": "[1,2]" })),
    ).toBeUndefined();
  });

  test("a throwing storage degrades silently", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
    };
    expect(loadExpandedGroups(broken)).toBeUndefined();
    expect(() => saveExpandedGroups(new Set(["x"]), broken)).not.toThrow();
  });
});

describe("the agent filter survives a reload (§12.7, FR-176, T313)", () => {
  test("round-trips both halves — the needle AND the all/online side", () => {
    const storage = memoryStorage();
    saveAgentFilter({ query: "dev", onlineOnly: true }, storage);
    expect(storage.data["muxeon-pref:agent-filter-state"]).toBe(
      '{"query":"dev","onlineOnly":true}',
    );
    expect(loadAgentFilter(storage)).toEqual({ query: "dev", onlineOnly: true });
  });

  test("each half persists on its own — an empty needle is not 'no record'", () => {
    const storage = memoryStorage();
    saveAgentFilter({ query: "", onlineOnly: true }, storage);
    expect(loadAgentFilter(storage)).toEqual({ query: "", onlineOnly: true });
    saveAgentFilter({ query: "tl", onlineOnly: false }, storage);
    expect(loadAgentFilter(storage)).toEqual({ query: "tl", onlineOnly: false });
  });

  test("a fresh browser gets the resting filter — the sidebar it always had", () => {
    expect(loadAgentFilter(memoryStorage())).toEqual(NO_FILTER);
  });

  // Half-restoring is the one outcome nobody can account for on screen: a needle
  // with no switch (or the reverse) filters the park for a reason the panel does
  // not show. Junk of every shape lands on the resting filter instead.
  test("junk of any shape yields the resting filter, never half of one", () => {
    const key = "muxeon-pref:agent-filter-state";
    expect(loadAgentFilter(memoryStorage({ [key]: "not json" }))).toEqual(NO_FILTER);
    expect(loadAgentFilter(memoryStorage({ [key]: "null" }))).toEqual(NO_FILTER);
    expect(loadAgentFilter(memoryStorage({ [key]: '["dev",true]' }))).toEqual(NO_FILTER);
    expect(loadAgentFilter(memoryStorage({ [key]: '{"query":"dev"}' }))).toEqual(NO_FILTER);
    expect(loadAgentFilter(memoryStorage({ [key]: '{"onlineOnly":true}' }))).toEqual(NO_FILTER);
    expect(loadAgentFilter(memoryStorage({ [key]: '{"query":7,"onlineOnly":true}' }))).toEqual(
      NO_FILTER,
    );
    expect(loadAgentFilter(memoryStorage({ [key]: '{"query":"dev","onlineOnly":"yes"}' }))).toEqual(
      NO_FILTER,
    );
  });

  test("a throwing storage degrades silently — the panel still filters", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
    };
    expect(loadAgentFilter(broken)).toEqual(NO_FILTER);
    expect(() => saveAgentFilter({ query: "dev", onlineOnly: true }, broken)).not.toThrow();
  });
});
