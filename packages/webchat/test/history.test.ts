// HistoryStore tests (T45, FR-39, §12.3): append-only JSONL per peer, id dedup
// (§10.9), crash-torn tail dropped on load, cursor paging backwards, the double
// retention cap, and restart survival (a fresh store reads the same files).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@teamai/core";
import { HistoryStore } from "../src/history";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "teamai-history-")), "operator-web");
});

afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

// Records must sit inside the default 90d age window (§12.3) — anchor at now.
const BASE = Date.now();

function record(id: string, overrides: Partial<Signal> = {}): Signal {
  return {
    id,
    from: "researcher",
    to: "operator-web",
    kind: "message",
    ts: BASE,
    payload: `payload of ${id}`,
    ...overrides,
  };
}

function store(options: { retain?: { ageMs?: number; count?: number }; now?: () => number } = {}) {
  return new HistoryStore({ dir, operator: "operator-web", ...options });
}

describe("append + dedup (§10.9)", () => {
  test("records land under the PEER's log, both directions", async () => {
    const history = store();
    await history.append(record("in-1")); // from researcher
    await history.append(record("out-1", { from: "operator-web", to: "researcher" }));
    const page = await history.page("researcher");
    expect(page.records.map((r) => r.id)).toEqual(["in-1", "out-1"]);
    const raw = readFileSync(join(dir, "researcher.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  test("a duplicate id is a no-op false — one line per id", async () => {
    const history = store();
    expect(await history.append(record("dup-1"))).toBe(true);
    expect(await history.append(record("dup-1"))).toBe(false);
    expect((await history.page("researcher")).records).toHaveLength(1);
  });

  test("concurrent appends serialize — no interleaved lines", async () => {
    const history = store();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => history.append(record(`c-${i}`, { ts: BASE + i }))),
    );
    const page = await history.page("researcher", { limit: 100 });
    expect(page.records).toHaveLength(20);
    const raw = readFileSync(join(dir, "researcher.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(20);
  });
});

describe("restart survival + torn tail (§12.3)", () => {
  test("a fresh store instance reads what an old one wrote", async () => {
    await store().append(record("persist-1"));
    const reborn = store();
    expect((await reborn.page("researcher")).records.map((r) => r.id)).toEqual(["persist-1"]);
  });

  test("a crash-torn (unterminated) tail is dropped, earlier records survive", async () => {
    await store().append(record("ok-1"));
    const file = join(dir, "researcher.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"id":"torn-`, { flag: "w" });
    const reborn = store();
    expect((await reborn.page("researcher")).records.map((r) => r.id)).toEqual(["ok-1"]);
    // and the cleaned view was persisted (the torn tail is gone from disk)
    expect(readFileSync(file, "utf8").includes("torn-")).toBe(false);
  });

  test("an unparsable line is skipped, not fatal", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "researcher.jsonl"),
      `not json at all\n${JSON.stringify(record("good-1"))}\n`,
    );
    expect((await store().page("researcher")).records.map((r) => r.id)).toEqual(["good-1"]);
  });
});

// --- export + clear (FR-84, §12.3) -------------------------------------------

describe("export + clear (FR-84)", () => {
  test("all() returns the peer's full chronological log", async () => {
    const history = store();
    await history.append(record("a-1", { ts: BASE - 2 }));
    await history.append(record("a-2", { ts: BASE - 1 }));
    await history.append(record("a-3"));
    expect((await history.all("researcher")).map((r) => r.id)).toEqual(["a-1", "a-2", "a-3"]);
    expect(await history.all("stranger")).toEqual([]); // no log — empty, not a throw
  });

  test("clear() drops the log: file gone, pages empty, unread zero, appends restart", async () => {
    const history = store();
    await history.append(record("c-1"));
    await history.append(record("c-2"));
    expect(await history.unread("researcher")).toBe(2);
    await history.clear("researcher");
    expect(await history.all("researcher")).toEqual([]);
    expect((await history.page("researcher")).records).toEqual([]);
    expect(await history.unread("researcher")).toBe(0);
    expect(await history.peers()).toEqual([]); // the .jsonl file is removed
    // the same id appends again — the dedup set was cleared with the records
    expect(await history.append(record("c-1"))).toBe(true);
    expect((await history.all("researcher")).map((r) => r.id)).toEqual(["c-1"]);
  });

  test("clear() survives a restart — a fresh store sees nothing", async () => {
    const history = store();
    await history.append(record("r-1"));
    await history.clear("researcher");
    expect(await store().all("researcher")).toEqual([]);
  });
});

describe("cursor paging backwards (§12.4)", () => {
  test("no cursor → the newest page; nextBefore walks older pages to the start", async () => {
    const history = store();
    for (let i = 0; i < 7; i += 1) await history.append(record(`m-${i}`, { ts: BASE + i }));
    const newest = await history.page("researcher", { limit: 3 });
    expect(newest.records.map((r) => r.id)).toEqual(["m-4", "m-5", "m-6"]);
    if (newest.nextBefore === undefined) throw new Error("expected a cursor");
    expect(newest.nextBefore).toBe("m-4");
    const older = await history.page("researcher", { before: newest.nextBefore, limit: 3 });
    expect(older.records.map((r) => r.id)).toEqual(["m-1", "m-2", "m-3"]);
    if (older.nextBefore === undefined) throw new Error("expected a cursor");
    const oldest = await history.page("researcher", { before: older.nextBefore, limit: 3 });
    expect(oldest.records.map((r) => r.id)).toEqual(["m-0"]);
    expect(oldest.nextBefore).toBeUndefined();
  });

  test("an unknown peer pages empty", async () => {
    expect((await store().page("ghost")).records).toEqual([]);
  });
});

describe("retention double cap (§12.3, §5.4-style)", () => {
  test("the count cap trims the oldest on append", async () => {
    const history = store({ retain: { count: 3 } });
    for (let i = 0; i < 5; i += 1) await history.append(record(`n-${i}`, { ts: BASE + i }));
    const page = await history.page("researcher", { limit: 10 });
    expect(page.records.map((r) => r.id)).toEqual(["n-2", "n-3", "n-4"]);
    const raw = readFileSync(join(dir, "researcher.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3); // the file was rewritten, not just the cache
  });

  test("the age cap drops expired records on prune()", async () => {
    let now = 1_000_000;
    const history = store({ retain: { ageMs: 100 }, now: () => now });
    await history.append(record("old-1", { ts: now - 200 })); // already past the floor...
    await history.append(record("new-1", { ts: now }));
    now += 50;
    await history.prune();
    expect((await store({ now: () => now }).page("researcher")).records.map((r) => r.id)).toEqual([
      "new-1",
    ]);
  });

  test("after pruning, a re-appended old id is accepted again (window semantics §10.9)", async () => {
    let now = 1_000_000;
    const history = store({ retain: { ageMs: 100 }, now: () => now });
    await history.append(record("w-1", { ts: now }));
    now += 1000;
    await history.prune();
    expect(await history.append(record("w-1", { ts: now }))).toBe(true);
  });
});

describe("blob GC sources + peer list (§12.3)", () => {
  test("listFiles returns the absolute log paths; peers round-trips names", async () => {
    const history = store();
    await history.append(record("a-1"));
    await history.append(record("b-1", { from: "writer" }));
    expect((await history.peers()).sort()).toEqual(["researcher", "writer"]);
    const files = await history.listFiles();
    expect(files).toHaveLength(2);
    for (const file of files) expect(file.startsWith(dir)).toBe(true);
  });

  test("a hostile peer name cannot traverse — it is encoded into the file name", async () => {
    const history = store();
    await history.append(record("evil-1", { from: "../../etc/passwd" }));
    const files = await history.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0]?.startsWith(dir)).toBe(true);
    expect(files[0]).not.toContain("..");
    expect((await history.peers())[0]).toBe("../../etc/passwd"); // logical name survives
  });
});

// The self-chat is not a pair (§17.7, FR-128): its thread is the PROJECTION of
// every pair log — one chronological feed of everything the user said and heard
// — while the pairs stay the only writers on disk.
describe("self-chat projection (§17.7, FR-128)", () => {
  test("every pair merges into one chronological thread, notes to self included", async () => {
    const history = store();
    await history.append(record("in-1", { from: "researcher", ts: BASE + 1 }));
    await history.append(record("out-1", { from: "operator-web", to: "writer", ts: BASE + 2 }));
    await history.append(record("in-2", { from: "writer", ts: BASE + 3 }));
    await history.append(
      record("note-1", { from: "operator-web", to: "operator-web", ts: BASE + 4 }),
    );
    const page = await history.projected();
    expect(page.records.map((r) => r.id)).toEqual(["in-1", "out-1", "in-2", "note-1"]);
    // the projection copies nothing: the pair logs are exactly what they were
    expect((await history.page("researcher")).records.map((r) => r.id)).toEqual(["in-1"]);
    expect((await history.page("writer")).records.map((r) => r.id)).toEqual(["out-1", "in-2"]);
  });

  test("records sharing a millisecond keep a stable total order", async () => {
    const history = store();
    await history.append(record("b", { from: "writer", ts: BASE }));
    await history.append(record("a", { from: "researcher", ts: BASE }));
    expect((await history.projected()).records.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("the cursor walks the merged feed to its start", async () => {
    const history = store();
    for (let i = 0; i < 6; i += 1) {
      await history.append(
        record(`m-${i}`, { from: i % 2 === 0 ? "researcher" : "writer", ts: BASE + i }),
      );
    }
    const newest = await history.projected({ limit: 4 });
    expect(newest.records.map((r) => r.id)).toEqual(["m-2", "m-3", "m-4", "m-5"]);
    if (newest.nextBefore === undefined) throw new Error("expected a cursor");
    const older = await history.projected({ before: newest.nextBefore, limit: 4 });
    expect(older.records.map((r) => r.id)).toEqual(["m-0", "m-1"]);
    expect(older.nextBefore).toBeUndefined();
  });

  test("newest() previews the aggregate, not the newest note to self", async () => {
    const history = store();
    await history.append(record("note", { from: "operator-web", to: "operator-web", ts: BASE }));
    await history.append(record("reply", { from: "writer", ts: BASE + 5 }));
    expect((await history.newest())?.id).toBe("reply");
    expect((await history.last("operator-web"))?.id).toBe("note");
  });

  test("an empty history projects an empty page", async () => {
    expect((await store().projected()).records).toEqual([]);
    expect(await store().newest()).toBeUndefined();
  });
});
