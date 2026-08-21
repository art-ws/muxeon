// What the rack prints INSIDE the composer (§20.4/§20.5, FR-185/FR-186). The
// pure rules live in prompt-name.test.ts and draft.test.ts; only the markup can
// answer these: that a rack the server does not have prints nothing at all, that
// "save" appears exactly when there is something to save, and that the dialog
// opens with the auto-name and says the composer keeps its text.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptRackItems, SavePromptDialog } from "../src/PromptRack";
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

const rack = (shelves: readonly PromptShelf[], enabled = true): PromptsApi => ({
  enabled,
  shelves,
  error: undefined,
  refresh: async () => undefined,
  createShelf: async () => "",
  renameShelf: async () => undefined,
  moveShelf: async () => undefined,
  removeShelf: async () => undefined,
  addPrompt: async () => undefined,
  editPrompt: async () => undefined,
  removePrompt: async () => undefined,
});

const items = (api: PromptsApi, text: string, onManage?: () => void): string =>
  renderToStaticMarkup(
    <PromptsContext.Provider value={api}>
      <PromptRackItems
        text={text}
        onInsert={() => undefined}
        onSave={() => undefined}
        {...(onManage !== undefined ? { onManage } : {})}
        closeMenu={() => undefined}
      />
    </PromptsContext.Provider>,
  );

describe("the rack items in the composer menu (§20.4/§20.5)", () => {
  test("a server without a rack prints nothing — not a menu that always fails", () => {
    expect(items(rack([shelf("Разбор", ["Ревью"])], false), "текст", () => undefined)).toBe("");
  });

  test("an empty rack with an empty composer prints nothing but the way to manage it", () => {
    expect(items(rack([]), "")).toBe("");
    expect(items(rack([]), "", () => undefined)).toContain("Manage shelves…");
  });

  test("«Save to shelf» appears exactly when there IS something to save", () => {
    expect(items(rack([shelf("Разбор", [])]), "  ")).not.toContain("Save to shelf");
    expect(items(rack([shelf("Разбор", [])]), "черновик")).toContain("Save to shelf");
  });

  test("«Insert from shelf» needs a prompt to insert — empty shelves are not offered", () => {
    expect(items(rack([shelf("Пустая", [])]), "")).not.toContain("Insert from shelf");
    expect(items(rack([shelf("Разбор", ["Ревью"])]), "")).toContain("Insert from shelf");
  });

  test("both submenus start closed — the menu is a menu, not a tree", () => {
    const html = items(rack([shelf("Разбор", ["Ревью"])]), "черновик");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Ревью"); // the leaf list opens on click
  });
});

describe("the save dialog (§20.4, FR-185/FR-188)", () => {
  const dialog = (text: string, shelfId?: string): string =>
    renderToStaticMarkup(
      <PromptsContext.Provider value={rack([shelf("Разбор", [])])}>
        <SavePromptDialog
          text={text}
          {...(shelfId !== undefined ? { shelf: shelfId } : {})}
          onClose={() => undefined}
        />
      </PromptsContext.Provider>,
    );

  test("the name field opens pre-filled with the auto-name (FR-188)", () => {
    expect(dialog("Посмотри diff и назови риски", "shelf-Разбор")).toContain(
      'value="Посмотри diff и назови риски"',
    );
  });

  test("saving onto a NEW shelf asks for the shelf's name too", () => {
    expect(dialog("текст")).toContain("Shelf name");
    expect(dialog("текст", "shelf-Разбор")).not.toContain("Shelf name");
  });

  test("the dialog says out loud that the composer keeps its text (§20.4)", () => {
    expect(dialog("текст", "shelf-Разбор")).toContain("The composer keeps its text");
  });
});
