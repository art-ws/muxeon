// The auto-name of a saved prompt (§20.7, FR-188): what the save dialog offers
// before the user edits it. Pure rules, no DOM.

import { describe, expect, test } from "bun:test";
import { AUTO_NAME_MAX, autoPromptName } from "../src/prompt-name";

describe("autoPromptName (§20.7, FR-188)", () => {
  test("short text becomes the name itself", () => {
    expect(autoPromptName("Ревью диффа")).toBe("Ревью диффа");
  });

  test("newlines and runs of spaces collapse — the name is one line by construction", () => {
    expect(autoPromptName("  Разбери\n\n  этот   diff  ")).toBe("Разбери этот diff");
  });

  test("long text is cut on a word boundary with an ellipsis", () => {
    const name = autoPromptName(
      "Посмотри диff и назови риски, которые видны прямо сейчас, без запуска тестов",
    );
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(AUTO_NAME_MAX + 1);
    expect(name.startsWith("Посмотри диff и назови риски")).toBe(true);
    expect(name).not.toContain(" …"); // the trailing space goes with the cut
  });

  test("one very long word is cut mid-word rather than reduced to nothing", () => {
    const name = autoPromptName("x".repeat(120));
    expect(name).toBe(`${"x".repeat(AUTO_NAME_MAX)}…`);
  });

  test("leading markup is dropped — a heading names the prompt, the hashes do not", () => {
    expect(autoPromptName("## Разбор кода")).toBe("Разбор кода");
    expect(autoPromptName("> цитата в начале")).toBe("цитата в начале");
    expect(autoPromptName("- пункт списка")).toBe("пункт списка");
    expect(autoPromptName("1. первый шаг")).toBe("первый шаг");
    expect(autoPromptName("```ts\nconst x = 1;")).toBe("const x = 1");
    expect(autoPromptName("**Важно**")).toBe("Важно");
  });

  test("nothing nameable falls back to the caller's string (the dictionary's, not ours)", () => {
    expect(autoPromptName("   ")).toBe("Untitled");
    expect(autoPromptName("###")).toBe("Untitled");
    expect(autoPromptName("", "Без названия")).toBe("Без названия");
  });
});
