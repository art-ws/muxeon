// Agent visibility filter (T110, FR-76): load/save round-trip via an injected
// storage, junk degrades to "show all", the sidebar filter honors the mode.

import { describe, expect, test } from "bun:test";
import {
  SHOW_ALL,
  type Visibility,
  loadVisibility,
  saveVisibility,
  setMode,
  toggleAgent,
  visiblePeers,
} from "../src/visibility";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  };
};

const KEY = "teamai-pref:visible-agents";

describe("agent visibility (FR-76)", () => {
  test("default is show-all; save/load round-trips the picks", () => {
    const storage = memoryStorage();
    expect(loadVisibility(storage)).toEqual(SHOW_ALL);

    const picked: Visibility = { mode: "selected", selected: new Set(["dev", "sherlock"]) };
    saveVisibility(picked, storage);
    expect(loadVisibility(storage)).toEqual(picked);

    saveVisibility(SHOW_ALL, storage);
    expect(loadVisibility(storage)).toEqual(SHOW_ALL);
  });

  test("the stored shape is plain sorted JSON", () => {
    const storage = memoryStorage();
    saveVisibility({ mode: "selected", selected: new Set(["z", "a"]) }, storage);
    expect(storage.dump()[KEY]).toBe('{"mode":"selected","selected":["a","z"]}');
  });

  test.each([
    ["not json"],
    ["42"],
    ["null"],
    ['{"mode":"sometimes","selected":[]}'], // unknown mode
    ['{"mode":"selected"}'], // missing list
    ['{"mode":"selected","selected":"dev"}'], // list is not an array
    ['{"mode":"selected","selected":[1,2]}'], // non-string entries
  ])("junk %p degrades to show-all", (raw) => {
    expect(loadVisibility(memoryStorage({ [KEY]: raw }))).toEqual(SHOW_ALL);
  });

  test("a throwing storage degrades silently on both paths", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadVisibility(broken)).toEqual(SHOW_ALL);
    expect(() => saveVisibility(SHOW_ALL, broken)).not.toThrow();
  });

  test("visiblePeers: 'all' passes through, 'selected' keeps only the picks", () => {
    const peers = [{ name: "dev" }, { name: "sherlock" }, { name: "makar" }];
    expect(visiblePeers(peers, SHOW_ALL)).toEqual(peers);
    expect(
      visiblePeers(peers, { mode: "selected", selected: new Set(["makar", "ghost"]) }),
    ).toEqual([{ name: "makar" }]);
    expect(visiblePeers(peers, { mode: "selected", selected: new Set() })).toEqual([]);
  });

  test("toggleAgent and setMode are immutable and keep the picks", () => {
    const start: Visibility = { mode: "selected", selected: new Set(["dev"]) };
    const more = toggleAgent(start, "makar");
    expect([...more.selected].sort()).toEqual(["dev", "makar"]);
    const less = toggleAgent(more, "dev");
    expect([...less.selected]).toEqual(["makar"]);
    expect([...start.selected]).toEqual(["dev"]); // untouched

    const all = setMode(less, "all");
    expect(all.mode).toBe("all");
    expect([...all.selected]).toEqual(["makar"]); // picks survive the flip
  });
});
