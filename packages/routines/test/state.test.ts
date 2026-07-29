import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStateStore } from "../src/state";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-rstate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createFsStateStore (§6)", () => {
  test("write/read round-trips and leaves no .tmp behind (atomic)", async () => {
    const store = createFsStateStore(dir);
    await store.write("researcher", "nightly", { lastRun: 1700000000000 });
    expect(await store.read("researcher", "nightly")).toEqual({ lastRun: 1700000000000 });
    expect(existsSync(join(dir, "routines", "researcher", "nightly.json.tmp"))).toBe(false);
  });

  test("reading a missing routine yields null (not an error)", async () => {
    expect(await createFsStateStore(dir).read("researcher", "ghost")).toBeNull();
  });

  test("list enumerates every persisted (owner,id), decoding names", async () => {
    const store = createFsStateStore(dir);
    await store.write("researcher", "a", { done: true, doneAt: 1 });
    await store.write("writer", "b/c", { lastRun: 2 }); // id with a separator → encoded on disk
    const refs = (await store.list()).map((r) => `${r.owner}/${r.id}`).sort();
    expect(refs).toEqual(["researcher/a", "writer/b/c"]);
  });

  test("remove deletes a routine's state (orphan pruning, §6.3)", async () => {
    const store = createFsStateStore(dir);
    await store.write("researcher", "a", { done: true, doneAt: 1 });
    await store.remove("researcher", "a");
    expect(await store.read("researcher", "a")).toBeNull();
  });
});
