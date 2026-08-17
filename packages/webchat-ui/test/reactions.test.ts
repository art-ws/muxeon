// Panel-side reaction state (§19.5/§19.9, FR-162/FR-168): the reducer folds the
// server's answer, the WS push updates every tab, a cleared chat loses its badges,
// and the picker orders Recent first.

import { describe, expect, test } from "bun:test";
import { pickerBlocks } from "../src/Reactions";
import {
  applyEvent,
  applyHistoryPage,
  applyReactions,
  initialState,
  reactionsOf,
} from "../src/store";
import type { ChatRecord, ReactionCatalog, ReactionView } from "../src/types";

const isOperator = (name: string): boolean => name === "shagin";

const record = (id: string, overrides: Partial<ChatRecord> = {}): ChatRecord => ({
  id,
  from: "muxeon",
  to: "shagin",
  kind: "message",
  ts: 1,
  payload: `payload ${id}`,
  ...overrides,
});

const view = (key: string, count = 1, mine = true): ReactionView => ({
  key,
  emoji: key === "ok" ? "👍" : "🔁",
  count,
  actors: [{ name: "shagin", ts: 5 }],
  mine,
});

describe("the reactions map (§19.5)", () => {
  test("a history page carries the badges of ITS records", () => {
    const state = applyHistoryPage(initialState, "muxeon", {
      records: [record("m1"), record("m2")],
      reactions: { m1: [view("ok")] },
    });
    expect(reactionsOf(state, "m1").map((r) => r.key)).toEqual(["ok"]);
    expect(reactionsOf(state, "m2")).toEqual([]);
  });

  test("an older page never invalidates a newer badge (only its own ids arrive)", () => {
    const first = applyHistoryPage(initialState, "muxeon", {
      records: [record("m2")],
      reactions: { m2: [view("ok")] },
    });
    const older = applyHistoryPage(first, "muxeon", {
      records: [record("m1")],
      reactions: { m1: [view("redo")] },
    });
    expect(reactionsOf(older, "m2").map((r) => r.key)).toEqual(["ok"]);
    expect(reactionsOf(older, "m1").map((r) => r.key)).toEqual(["redo"]);
  });

  test("the folded answer REPLACES the list; an empty one drops the entry", () => {
    const placed = applyReactions(initialState, "m1", [view("ok"), view("redo")]);
    expect(reactionsOf(placed, "m1")).toHaveLength(2);
    const removed = applyReactions(placed, "m1", []);
    expect(reactionsOf(removed, "m1")).toEqual([]);
    expect(Object.keys(removed.reactions)).toEqual([]);
  });

  test("the WS push updates every tab, the placing one included", () => {
    const state = applyEvent(
      initialState,
      { type: "reaction", peer: "muxeon", messageId: "m1", reactions: [view("ok", 2, false)] },
      isOperator,
    );
    expect(reactionsOf(state, "m1")[0]).toMatchObject({ key: "ok", count: 2, mine: false });
  });

  test("one entry serves both the pair thread and the self-chat (ids are unique)", () => {
    // The same record shows in two threads (§17.7) — but reactions are keyed by
    // message id, so there is nothing to keep in sync.
    const state = applyReactions(initialState, "m1", [view("ok")]);
    expect(reactionsOf(state, "m1")).toHaveLength(1);
  });

  test("clearing a chat drops the badges of the records that went with it (FR-84)", () => {
    const loaded = applyHistoryPage(initialState, "muxeon", {
      records: [record("m1"), record("m2")],
      reactions: { m1: [view("ok")], m2: [view("redo")] },
    });
    const cleared = applyEvent(loaded, { type: "history-cleared", peer: "muxeon" }, isOperator);
    expect(cleared.reactions).toEqual({});
  });

  test("a page without a reactions field leaves the map alone (an older server)", () => {
    const placed = applyReactions(initialState, "m1", [view("ok")]);
    const paged = applyHistoryPage(placed, "muxeon", { records: [record("m1")] });
    expect(reactionsOf(paged, "m1")).toHaveLength(1);
  });
});

describe("picker blocks (§19.8/§19.9)", () => {
  const catalog = (recent: string[]): ReactionCatalog => ({
    categories: [
      { name: "feedback", title: "Отклик" },
      { name: "work" },
      { name: "empty", title: "Empty" },
    ],
    items: [
      { key: "ok", emoji: "👍", category: "feedback" },
      { key: "redo", emoji: "🔁", category: "work" },
      { key: "fire", emoji: "🔥" },
    ],
    recent,
  });

  test("Recent comes FIRST, in the server's frequency order", () => {
    const blocks = pickerBlocks(catalog(["redo", "ok"]));
    expect(blocks[0]?.name).toBe("recent");
    expect(blocks[0]?.items.map((item) => item.key)).toEqual(["redo", "ok"]);
  });

  test("no usage yet ⇒ no Recent block at all", () => {
    expect(pickerBlocks(catalog([])).map((block) => block.name)).toEqual(["feedback", "work", ""]);
  });

  test("categories keep config order; a title defaults to the name; empty ones are skipped", () => {
    const blocks = pickerBlocks(catalog([]));
    expect(blocks.map((block) => block.title)).toEqual(["Отклик", "work", ""]);
  });

  test("uncategorized items land in a LAST block with no heading", () => {
    const blocks = pickerBlocks(catalog([]));
    expect(blocks.at(-1)?.items.map((item) => item.key)).toEqual(["fire"]);
  });

  test("a Recent key missing from the palette is skipped, not rendered blank", () => {
    const blocks = pickerBlocks(catalog(["ghost", "ok"]));
    expect(blocks[0]?.items.map((item) => item.key)).toEqual(["ok"]);
  });
});
