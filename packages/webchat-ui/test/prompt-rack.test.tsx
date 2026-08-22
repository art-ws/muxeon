// What the rack prints INSIDE the composer (§20.4/§20.5, FR-185/FR-186). The
// pure rules live in prompt-name.test.ts and draft.test.ts; only the markup can
// answer these: that a rack the server does not have prints nothing at all, that
// "save" appears exactly when there is something to save, and that the dialog
// opens with the auto-name and says the composer keeps its text.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptRackItems, SavePromptDialog } from "../src/PromptRack";
import { type PromptsApi, PromptsContext } from "../src/prompts-context";
import { TOOLS } from "../src/tools";
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

const items = (api: PromptsApi, text: string, onManage?: () => void, offered = true): string =>
  renderToStaticMarkup(
    <PromptsContext.Provider value={api}>
      <PromptRackItems
        text={text}
        onInsert={() => undefined}
        onSave={() => undefined}
        {...(onManage !== undefined ? { onManage } : {})}
        offered={offered}
        closeMenu={() => undefined}
      />
    </PromptsContext.Provider>,
  );

describe("the rack items in the composer menu (§20.4/§20.5)", () => {
  test("a server without a rack prints nothing — not a menu that always fails", () => {
    expect(items(rack([shelf("Разбор", ["Ревью"])], false), "текст", () => undefined)).toBe("");
  });

  // FR-189: hidden by preference is the same silence as "the server has no rack"
  // — a full rack, a filled composer and a way to the page still print NOTHING,
  // because the point of hiding is a menu without these entries in it.
  test("a rack hidden by preference prints nothing either — every entry, not some", () => {
    const full = rack([shelf("Разбор", ["Ревью"])]);
    expect(items(full, "черновик", () => undefined, false)).toBe("");
    // …and the same call with it offered is not empty, so the case proves something
    expect(items(full, "черновик", () => undefined, true)).not.toBe("");
  });

  test("an empty rack with an empty composer prints nothing but the way to manage it", () => {
    expect(items(rack([]), "")).toBe("");
    expect(items(rack([]), "", () => undefined)).toContain("Prompts");
  });

  // One destination, one name (FR-171/FR-187): the composer's line, the account
  // menu's and the toolbar entry all open #/prompts, so the reader must not have
  // to guess whether three different names mean three different pages.
  test("the way to the rack page is named exactly as the toolbar entry", () => {
    const entry = TOOLS.find((tool) => tool.id === "prompts");
    expect(entry?.label).toBe("Prompts");
    expect(items(rack([]), "", () => undefined)).toContain(`${entry?.label}</button>`);
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
