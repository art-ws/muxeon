// UI languages (T114, FR-78): the language pref round-trips with the prefs
// discipline (junk → English), dictionaries validate strictly, and the
// translator falls back to the English source for anything missing.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LANG,
  LANGS,
  loadLang,
  normalizeLang,
  parseMessages,
  saveLang,
  translator,
} from "../src/i18n";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};

describe("UI languages (FR-78)", () => {
  test("English is the default and the source language", () => {
    expect(DEFAULT_LANG).toBe("en");
    expect(LANGS[0]?.code).toBe("en");
  });

  test.each([["en"], ["ru"]])("the %p choice round-trips through storage", (code) => {
    const storage = memoryStorage();
    saveLang(normalizeLang(code), storage);
    expect(loadLang(storage)).toBe(code);
  });

  test.each([[null], ["de"], ["RU"], [42], ["ruru"]])(
    "junk lang %p falls back to English",
    (raw) => {
      expect(normalizeLang(raw)).toBe("en");
      expect(loadLang(memoryStorage({ "teamai-pref:lang": String(raw) }))).toBe(
        raw === "ru" ? "ru" : "en",
      );
    },
  );

  test("a throwing storage degrades silently on both paths", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadLang(broken)).toBe("en");
    expect(() => saveLang("ru", broken)).not.toThrow();
  });

  test("parseMessages keeps only string→non-empty-string entries", () => {
    expect(parseMessages({ "Sign out": "Выйти", junk: 42, empty: "", nested: { a: 1 } })).toEqual({
      "Sign out": "Выйти",
    });
    expect(parseMessages(null)).toEqual({});
    expect(parseMessages("text")).toEqual({});
    expect(parseMessages([1, 2])).toEqual({});
  });

  test("translator: hit translates, miss and no-dictionary pass English through", () => {
    const t = translator({ "Sign out": "Выйти" });
    expect(t("Sign out")).toBe("Выйти");
    expect(t("Settings")).toBe("Settings"); // missing key → English source
    const none = translator(undefined); // no dictionary at all (FR-78: optional)
    expect(none("Sign out")).toBe("Sign out");
  });

  test("the shipped ru.json is a valid dictionary", async () => {
    const raw: unknown = await Bun.file(
      new URL("../assets/i18n/ru.json", import.meta.url).pathname,
    ).json();
    const messages = parseMessages(raw);
    // strict parse must not drop anything from the file we actually ship
    expect(Object.keys(messages).length).toBe(Object.keys(raw as object).length);
    expect(messages["Sign out"]).toBe("Выйти");
  });
});
