// Draft persistence (T93, FR-69, §12.7): per-peer text + manual height in
// localStorage; junk parses to the empty draft, a blocked storage degrades
// silently, an empty draft removes its key.

import { describe, expect, test } from "bun:test";
import { EMPTY_DRAFT, loadDraft, normalizeDraft, saveDraft } from "../src/draft-store";

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("draft round-trip (FR-69)", () => {
  test("save → load returns the draft, keyed per peer", () => {
    const storage = fakeStorage();
    saveDraft("dev", { text: "hello\nworld", height: 120 }, storage);
    saveDraft("tl", { text: "other" }, storage);
    expect(loadDraft("dev", storage)).toEqual({ text: "hello\nworld", height: 120 });
    expect(loadDraft("tl", storage)).toEqual({ text: "other" });
    expect(loadDraft("ceo", storage)).toEqual(EMPTY_DRAFT); // untouched peer — empty
  });

  test("an empty draft removes the key — no localStorage litter", () => {
    const storage = fakeStorage();
    saveDraft("dev", { text: "draft" }, storage);
    expect(storage.map.size).toBe(1);
    saveDraft("dev", { text: "" }, storage);
    expect(storage.map.size).toBe(0);
  });

  test("a height-only draft persists (the resize outlives a sent message)", () => {
    const storage = fakeStorage();
    saveDraft("dev", { text: "", height: 200 }, storage);
    expect(loadDraft("dev", storage)).toEqual({ text: "", height: 200 });
  });
});

describe("junk tolerance (FR-69)", () => {
  test.each([
    ["not json", "{nope"],
    ["a string", JSON.stringify("text")],
    ["an array", JSON.stringify(["text"])],
    ["null", JSON.stringify(null)],
  ])("%s in storage → the empty draft", (_label, raw) => {
    const storage = fakeStorage({ "teamai-draft:dev": raw });
    expect(loadDraft("dev", storage)).toEqual(EMPTY_DRAFT);
  });

  test("normalizeDraft drops a junk height and keeps the text", () => {
    expect(normalizeDraft({ text: "keep", height: -5 })).toEqual({ text: "keep" });
    expect(normalizeDraft({ text: "keep", height: Number.NaN })).toEqual({ text: "keep" });
    expect(normalizeDraft({ text: 42, height: 99.6 })).toEqual({ text: "", height: 100 });
  });

  test("a throwing storage degrades silently — load empty, save no-op", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadDraft("dev", broken)).toEqual(EMPTY_DRAFT);
    expect(() => saveDraft("dev", { text: "x" }, broken)).not.toThrow();
    expect(() => saveDraft("dev", { text: "" }, broken)).not.toThrow();
  });
});
