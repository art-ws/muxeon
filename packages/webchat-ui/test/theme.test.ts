// Theme switching (T79, §12.7, FR-59): light is the DEFAULT, the persisted
// choice wins, junk/blocked storage degrades to the default — never a crash.

import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME, applyTheme, loadTheme, normalizeTheme, otherTheme } from "../src/theme";

function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly data: Record<string, string>;
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

describe("theme (FR-59)", () => {
  test("light is the default", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(loadTheme(memoryStorage())).toBe("light"); // nothing stored yet
  });

  test.each([
    ["dark", "dark"],
    ["light", "light"],
    ["junk", "light"],
    [null, "light"],
    [42, "light"],
  ])("normalizeTheme(%p) → %p", (value, expected) => {
    expect(normalizeTheme(value)).toBe(expected as "light" | "dark");
  });

  test("otherTheme flips both ways", () => {
    expect(otherTheme("light")).toBe("dark");
    expect(otherTheme("dark")).toBe("light");
  });

  test("a stored choice wins over the default", () => {
    expect(loadTheme(memoryStorage({ "muxeon-theme": "dark" }))).toBe("dark");
  });

  test("a blocked storage degrades to the default, not a crash", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadTheme(blocked)).toBe("light");
    const root = { dataset: {} as { theme?: string } };
    applyTheme("dark", root, blocked); // persist fails — the attribute still lands
    expect(root.dataset.theme).toBe("dark");
  });

  test("applyTheme sets <html data-theme> and persists; loadTheme round-trips", () => {
    const storage = memoryStorage();
    const root = { dataset: {} as { theme?: string } };
    applyTheme("dark", root, storage);
    expect(root.dataset.theme).toBe("dark");
    expect(loadTheme(storage)).toBe("dark");
    applyTheme("light", root, storage);
    expect(root.dataset.theme).toBe("light");
    expect(loadTheme(storage)).toBe("light");
  });
});
