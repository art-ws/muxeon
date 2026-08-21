// What the rack page prints (§20.6, FR-187): both columns, the counts, the
// editor of the selected shelf's first prompt — and the two rules a screenshot
// cannot be trusted to keep: a delete starts UNARMED, and reordering is buttons,
// never a drag handle.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptsPage } from "../src/PromptsPage";
import { type PromptsApi, PromptsContext } from "../src/prompts-context";
import type { PromptShelf } from "../src/types";

const shelf = (name: string, prompts: readonly string[]): PromptShelf => ({
  id: `shelf-${name}`,
  name,
  created: 0,
  updated: 0,
  prompts: prompts.map((prompt) => ({
    id: `prompt-${prompt}`,
    name: prompt,
    text: `body of ${prompt}`,
    created: 0,
    updated: 0,
  })),
});

const page = (shelves: readonly PromptShelf[], error?: string): string => {
  const api: PromptsApi = {
    enabled: true,
    shelves,
    error,
    refresh: async () => undefined,
    createShelf: async () => "",
    renameShelf: async () => undefined,
    moveShelf: async () => undefined,
    removeShelf: async () => undefined,
    addPrompt: async () => undefined,
    editPrompt: async () => undefined,
    removePrompt: async () => undefined,
  };
  return renderToStaticMarkup(
    <PromptsContext.Provider value={api}>
      <PromptsPage />
    </PromptsContext.Provider>,
  );
};

describe("the rack page (§20.6, FR-187)", () => {
  test("an empty rack says so instead of showing a blank column", () => {
    const html = page([]);
    expect(html).toContain("No shelves yet.");
  });

  test("shelves print with the number of prompts standing on them", () => {
    const html = page([shelf("Разбор", ["Ревью", "Тесты"]), shelf("Письма", [])]);
    expect(html).toContain("Разбор");
    expect(html).toContain("Письма");
    expect(html).toContain(">2<"); // the count of the first shelf
  });

  test("the first shelf opens by default, with its prompts and its filter", () => {
    const html = page([shelf("Разбор", ["Ревью"])]);
    expect(html).toContain("Ревью");
    expect(html).toContain("Filter prompts…");
  });

  test("an empty shelf says it is empty — no phantom editor", () => {
    const html = page([shelf("Пустая", [])]);
    expect(html).toContain("Empty shelf.");
    expect(html).not.toContain("Prompt text");
  });

  test("a delete starts UNARMED: the first click cannot take a shelf away", () => {
    const html = page([shelf("Разбор", ["Ревью"])]);
    expect(html).not.toContain("Sure?");
    expect(html).toContain("ghost-button danger");
  });

  test("reordering is buttons, not a drag handle", () => {
    const html = page([shelf("A", ["x"]), shelf("B", [])]);
    expect(html).toContain('title="Move up"');
    expect(html).toContain('title="Move down"');
    expect(html).not.toContain("draggable");
  });

  test("a rack-level failure is shown, not swallowed", () => {
    expect(page([], "the prompt library is unreadable")).toContain(
      "the prompt library is unreadable",
    );
  });
});
