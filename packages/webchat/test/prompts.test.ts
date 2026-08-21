// The prompt rack's store (§20.1/§20.2, FR-183): shelves and prompts on disk, the
// caps that refuse instead of trimming, and the two properties the whole feature
// leans on — one file per OWNER, and a broken file that fails loudly rather than
// coming back as an empty rack the user would refill over their own data.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_LIMITS, PromptError, PromptStore, normalizeName } from "../src/prompts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-prompts-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function store(): PromptStore {
  let seq = 0;
  let clock = 1_000;
  return new PromptStore({
    dir: join(root, "prompts"),
    now: () => {
      clock += 1;
      return clock;
    },
    newId: () => {
      seq += 1;
      return `id-${seq}`;
    },
  });
}

/** The rack after one shelf with one prompt — the shape most tests start from. */
async function seeded(
  s: PromptStore,
  owner = "shagin",
): Promise<{ shelf: string; prompt: string }> {
  const withShelf = await s.createShelf(owner, "Разбор кода");
  const shelf = withShelf.shelves[0]?.id ?? "";
  const withPrompt = await s.createPrompt(owner, {
    shelf,
    name: "Ревью диффа",
    text: "Посмотри диff и назови риски.",
  });
  return { shelf, prompt: withPrompt.shelves[0]?.prompts[0]?.id ?? "" };
}

async function refusal(op: Promise<unknown>): Promise<PromptError> {
  try {
    await op;
  } catch (error) {
    if (error instanceof PromptError) return error;
    throw error;
  }
  throw new Error("expected a PromptError, the operation succeeded");
}

describe("the empty rack (§20.2)", () => {
  test("a user who never saved anything gets an empty rack, not an error", async () => {
    expect(await store().library("nobody")).toEqual({ version: 1, shelves: [] });
  });

  test("reading does not create a file — an untouched user leaves no sidecar", async () => {
    const s = store();
    await s.library("nobody");
    expect(existsSync(join(root, "prompts"))).toBe(false);
  });
});

describe("shelves (§20.1, FR-183)", () => {
  test("a new shelf lands at the END, keeping the manual order", async () => {
    const s = store();
    await s.createShelf("shagin", "Первая");
    const library = await s.createShelf("shagin", "Вторая");
    expect(library.shelves.map((shelf) => shelf.name)).toEqual(["Первая", "Вторая"]);
  });

  test("a duplicate name is refused case-insensitively — two identical submenu rows are a coin toss", async () => {
    const s = store();
    await s.createShelf("shagin", "Разбор кода");
    const error = await refusal(s.createShelf("shagin", "  разбор   КОДА "));
    expect(error.code).toBe("DUPLICATE_NAME");
    expect((await s.library("shagin")).shelves).toHaveLength(1);
  });

  test("an empty name is INVALID and an over-long one is LIMIT — never a silent trim", async () => {
    const s = store();
    expect((await refusal(s.createShelf("shagin", "   "))).code).toBe("INVALID");
    const long = "x".repeat(PROMPT_LIMITS.nameMax + 1);
    expect((await refusal(s.createShelf("shagin", long))).code).toBe("LIMIT");
  });

  test("rename keeps the id — a shelf's identity is not its caption", async () => {
    const s = store();
    const created = await s.createShelf("shagin", "Черновик");
    const id = created.shelves[0]?.id ?? "";
    const renamed = await s.updateShelf("shagin", id, { name: "Разбор кода" });
    expect(renamed.shelves[0]).toMatchObject({ id, name: "Разбор кода" });
  });

  test("renaming a shelf to its OWN name is not a duplicate of itself", async () => {
    const s = store();
    const created = await s.createShelf("shagin", "Разбор кода");
    const id = created.shelves[0]?.id ?? "";
    const renamed = await s.updateShelf("shagin", id, { name: "разбор кода" });
    expect(renamed.shelves[0]?.name).toBe("разбор кода");
  });

  test("position moves the shelf; a position past the end clamps instead of throwing", async () => {
    const s = store();
    await s.createShelf("shagin", "A");
    await s.createShelf("shagin", "B");
    const third = await s.createShelf("shagin", "C");
    const id = third.shelves[2]?.id ?? "";
    const front = await s.updateShelf("shagin", id, { position: 0 });
    expect(front.shelves.map((shelf) => shelf.name)).toEqual(["C", "A", "B"]);
    const back = await s.updateShelf("shagin", id, { position: 99 });
    expect(back.shelves.map((shelf) => shelf.name)).toEqual(["A", "B", "C"]);
  });

  test("deleting a shelf takes its prompts with it (§20.3)", async () => {
    const s = store();
    const { shelf } = await seeded(s);
    expect((await s.deleteShelf("shagin", shelf)).shelves).toEqual([]);
  });

  test("an unknown shelf is UNKNOWN_SHELF, not a silent no-op", async () => {
    const s = store();
    expect((await refusal(s.deleteShelf("shagin", "nope"))).code).toBe("UNKNOWN_SHELF");
    expect((await refusal(s.updateShelf("shagin", "nope", { name: "x" }))).code).toBe(
      "UNKNOWN_SHELF",
    );
  });

  test("the shelf cap refuses the next shelf", async () => {
    const s = store();
    for (let index = 0; index < PROMPT_LIMITS.shelvesMax; index++) {
      await s.createShelf("shagin", `shelf ${index}`);
    }
    expect((await refusal(s.createShelf("shagin", "one more"))).code).toBe("LIMIT");
  });
});

describe("prompts (§20.1, FR-183)", () => {
  test("a prompt is stored verbatim — the text is the payload, not a caption", async () => {
    const s = store();
    const { shelf } = await seeded(s);
    const text = "  строка\n\n  вторая  ";
    const library = await s.createPrompt("shagin", { shelf, name: "As is", text });
    expect(library.shelves[0]?.prompts[1]?.text).toBe(text);
  });

  test("the name is normalized (trim + collapsed whitespace) while the text is not", async () => {
    expect(normalizeName("  Ревью   диффа \n")).toBe("Ревью диффа");
    const s = store();
    const { shelf } = await seeded(s);
    const library = await s.createPrompt("shagin", {
      shelf,
      name: "  Второй   промпт  ",
      text: "тело",
    });
    expect(library.shelves[0]?.prompts[1]?.name).toBe("Второй промпт");
  });

  test("a duplicate name is refused ON ITS SHELF and allowed on another one", async () => {
    const s = store();
    const { shelf } = await seeded(s);
    expect(
      (await refusal(s.createPrompt("shagin", { shelf, name: "ревью ДИФФА", text: "x" }))).code,
    ).toBe("DUPLICATE_NAME");
    const second = await s.createShelf("shagin", "Другая полка");
    const other = second.shelves[1]?.id ?? "";
    const library = await s.createPrompt("shagin", {
      shelf: other,
      name: "Ревью диффа",
      text: "x",
    });
    expect(library.shelves[1]?.prompts).toHaveLength(1);
  });

  test("an empty text is INVALID and an over-long one is LIMIT", async () => {
    const s = store();
    const { shelf } = await seeded(s);
    expect((await refusal(s.createPrompt("shagin", { shelf, name: "a", text: " " }))).code).toBe(
      "INVALID",
    );
    const long = "x".repeat(PROMPT_LIMITS.textMax + 1);
    expect((await refusal(s.createPrompt("shagin", { shelf, name: "b", text: long }))).code).toBe(
      "LIMIT",
    );
  });

  test("a prompt on an unknown shelf is UNKNOWN_SHELF", async () => {
    const s = store();
    expect(
      (await refusal(s.createPrompt("shagin", { shelf: "nope", name: "a", text: "b" }))).code,
    ).toBe("UNKNOWN_SHELF");
  });

  test("editing the text keeps id, name and created; updated moves", async () => {
    const s = store();
    const { prompt } = await seeded(s);
    const before = (await s.library("shagin")).shelves[0]?.prompts[0];
    const library = await s.updatePrompt("shagin", prompt, { text: "новое тело" });
    const after = library.shelves[0]?.prompts[0];
    expect(after).toMatchObject({ id: prompt, name: before?.name, created: before?.created });
    expect(after?.text).toBe("новое тело");
    expect(after?.updated).toBeGreaterThan(before?.updated ?? 0);
  });

  test("moving a prompt to another shelf takes it off the first one", async () => {
    const s = store();
    const { prompt } = await seeded(s);
    const withSecond = await s.createShelf("shagin", "Вторая");
    const target = withSecond.shelves[1]?.id ?? "";
    const library = await s.updatePrompt("shagin", prompt, { shelf: target });
    expect(library.shelves[0]?.prompts).toEqual([]);
    expect(library.shelves[1]?.prompts.map((item) => item.id)).toEqual([prompt]);
  });

  test("a move onto a shelf that already has that name is refused (the name travels too)", async () => {
    const s = store();
    const { prompt } = await seeded(s);
    const withSecond = await s.createShelf("shagin", "Вторая");
    const target = withSecond.shelves[1]?.id ?? "";
    await s.createPrompt("shagin", { shelf: target, name: "Ревью диффа", text: "x" });
    const error = await refusal(
      s.updatePrompt("shagin", prompt, { shelf: target, name: "Ревью диффа" }),
    );
    expect(error.code).toBe("DUPLICATE_NAME");
  });

  test("position reorders within the shelf", async () => {
    const s = store();
    const { shelf } = await seeded(s);
    await s.createPrompt("shagin", { shelf, name: "Второй", text: "x" });
    const third = await s.createPrompt("shagin", { shelf, name: "Третий", text: "x" });
    const id = third.shelves[0]?.prompts[2]?.id ?? "";
    const library = await s.updatePrompt("shagin", id, { position: 0 });
    expect(library.shelves[0]?.prompts.map((item) => item.name)).toEqual([
      "Третий",
      "Ревью диффа",
      "Второй",
    ]);
  });

  test("an unknown prompt is UNKNOWN_PROMPT", async () => {
    const s = store();
    await seeded(s);
    expect((await refusal(s.deletePrompt("shagin", "nope"))).code).toBe("UNKNOWN_PROMPT");
    expect((await refusal(s.updatePrompt("shagin", "nope", { text: "x" }))).code).toBe(
      "UNKNOWN_PROMPT",
    );
  });

  test("the per-shelf cap refuses the next prompt", async () => {
    const s = store();
    const { shelf } = await seeded(s);
    for (let index = 1; index < PROMPT_LIMITS.promptsPerShelfMax; index++) {
      await s.createPrompt("shagin", { shelf, name: `prompt ${index}`, text: "x" });
    }
    expect(
      (await refusal(s.createPrompt("shagin", { shelf, name: "one more", text: "x" }))).code,
    ).toBe("LIMIT");
  });
});

describe("the sidecar on disk (§20.2)", () => {
  test("one file per owner, and one owner never appears in another's rack (§10.32)", async () => {
    const s = store();
    await seeded(s, "shagin");
    await s.createShelf("alex", "Своя полка");
    expect((await s.library("alex")).shelves.map((shelf) => shelf.name)).toEqual(["Своя полка"]);
    expect((await s.library("shagin")).shelves.map((shelf) => shelf.name)).toEqual(["Разбор кода"]);
    expect(existsSync(join(root, "prompts", "shagin.json"))).toBe(true);
    expect(existsSync(join(root, "prompts", "alex.json"))).toBe(true);
  });

  test("an owner name with a path separator cannot leave the directory", async () => {
    const s = store();
    await s.createShelf("../escape", "Полка");
    expect(existsSync(join(root, "prompts", "..", "escape.json"))).toBe(false);
    expect((await s.library("../escape")).shelves).toHaveLength(1);
  });

  test("the rack survives a fresh store — it lives on disk, not in memory", async () => {
    await seeded(store());
    const library = await store().library("shagin");
    expect(library.shelves[0]?.prompts[0]?.name).toBe("Ревью диффа");
  });

  test("a broken file is LIBRARY_UNREADABLE and is left ON DISK untouched", async () => {
    const s = store();
    await seeded(s);
    const file = join(root, "prompts", "shagin.json");
    const damaged = "{ this is not json";
    writeFileSync(file, damaged, "utf8");
    expect((await refusal(s.library("shagin"))).code).toBe("LIBRARY_UNREADABLE");
    // A mutation on top of a broken file must not "start over" either.
    expect((await refusal(s.createShelf("shagin", "Новая"))).code).toBe("LIBRARY_UNREADABLE");
    expect(readFileSync(file, "utf8")).toBe(damaged);
  });

  test("a file of the wrong SHAPE is unreadable too — the data is worth an error", async () => {
    const s = store();
    await seeded(s);
    writeFileSync(join(root, "prompts", "shagin.json"), JSON.stringify({ version: 9 }), "utf8");
    expect((await refusal(s.library("shagin"))).code).toBe("LIBRARY_UNREADABLE");
  });

  test("concurrent writes of one owner both land — no lost update (§20.3)", async () => {
    const s = store();
    await Promise.all([
      s.createShelf("shagin", "Первая"),
      s.createShelf("shagin", "Вторая"),
      s.createShelf("shagin", "Третья"),
    ]);
    expect((await s.library("shagin")).shelves.map((shelf) => shelf.name).sort()).toEqual([
      "Вторая",
      "Первая",
      "Третья",
    ]);
  });

  test("a refusal does not poison the owner's chain — the next call still works", async () => {
    const s = store();
    await refusal(s.createShelf("shagin", ""));
    const library = await s.createShelf("shagin", "Полка");
    expect(library.shelves).toHaveLength(1);
  });
});
