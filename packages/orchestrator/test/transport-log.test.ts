import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@teamai/core";
import { TransportLog } from "../src/transport-log";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "teamai-transport-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(id: string, overrides: Partial<Signal> = {}): Signal {
  return {
    id,
    from: "teamai",
    to: "qwen",
    kind: "message",
    ts: 1000,
    payload: `payload of ${id}`,
    ...overrides,
  };
}

const logFile = (): string => join(root, "observe", "transport.jsonl");

// --- pair history (T126, FR-87) -------------------------------------------------

describe("TransportLog.pair (FR-87)", () => {
  test("returns the pair's records only, both directions, chronological", async () => {
    const log = new TransportLog({ root });
    const now = Date.now();
    await log.append(record("p-1", { ts: now }));
    await log.append(record("x-1", { from: "teamai", to: "sherlock", ts: now + 1 }));
    await log.append(record("p-2", { from: "qwen", to: "teamai", ts: now + 2 }));
    await log.append(record("x-2", { from: "sherlock", to: "qwen", ts: now + 3 }));
    await log.append(record("p-3", { ts: now + 4 }));
    expect((await log.pair("teamai", "qwen", 50)).map((r) => r.id)).toEqual(["p-1", "p-2", "p-3"]);
    expect((await log.pair("qwen", "teamai", 50)).map((r) => r.id)).toEqual(["p-1", "p-2", "p-3"]); // symmetric
  });

  test("the depth limit keeps the NEWEST records", async () => {
    const log = new TransportLog({ root });
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) await log.append(record(`d-${i}`, { ts: now + i }));
    expect((await log.pair("teamai", "qwen", 2)).map((r) => r.id)).toEqual(["d-3", "d-4"]);
  });

  test("an unknown pair is an empty list, not a throw", async () => {
    const log = new TransportLog({ root });
    expect(await log.pair("nobody", "no-one", 10)).toEqual([]);
  });
});

describe("TransportLog (§8.2, FR-48)", () => {
  test("appends every routed record durably and pages them back in order", async () => {
    const log = new TransportLog({ root });
    expect(await log.append(record("a"))).toBe(true);
    expect(await log.append(record("b", { from: "qwen", to: "teamai" }))).toBe(true);
    const raw = await readFile(logFile(), "utf8");
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(2);
    const page = await log.page();
    expect(page.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(page.nextBefore).toBeUndefined();
  });

  test("duplicate ids are a no-op (§10.9 at-least-once)", async () => {
    const log = new TransportLog({ root });
    await log.append(record("a"));
    expect(await log.append(record("a"))).toBe(false);
    expect((await log.page()).records).toHaveLength(1);
  });

  test("pages backwards by cursor", async () => {
    const log = new TransportLog({ root });
    for (const id of ["a", "b", "c", "d", "e"]) await log.append(record(id));
    const newest = await log.page({ limit: 2 });
    expect(newest.records.map((r) => r.id)).toEqual(["d", "e"]);
    expect(newest.nextBefore).toBe("d");
    const older = await log.page({ before: newest.nextBefore as string, limit: 2 });
    expect(older.records.map((r) => r.id)).toEqual(["b", "c"]);
    const oldest = await log.page({ before: older.nextBefore as string, limit: 2 });
    expect(oldest.records.map((r) => r.id)).toEqual(["a"]);
    expect(oldest.nextBefore).toBeUndefined();
  });

  test("subscribers see fresh records only — not duplicates", async () => {
    const log = new TransportLog({ root });
    const seen: string[] = [];
    const unsubscribe = log.subscribe((r) => seen.push(r.id));
    await log.append(record("a"));
    await log.append(record("a")); // duplicate — no event
    unsubscribe();
    await log.append(record("b")); // after unsubscribe — no event
    expect(seen).toEqual(["a"]);
  });

  test("a broken subscriber does not break the append or its siblings", async () => {
    const log = new TransportLog({ root });
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error("broken listener");
    });
    log.subscribe((r) => seen.push(r.id));
    expect(await log.append(record("a"))).toBe(true);
    expect(seen).toEqual(["a"]);
  });

  test("a crash-torn tail and unparsable lines are dropped on load", async () => {
    const log = new TransportLog({ root, now: () => 2000 });
    await log.append(record("a"));
    const raw = await readFile(logFile(), "utf8");
    await writeFile(logFile(), `${raw}not json\n${JSON.stringify(record("b"))}\n{"torn`, "utf8");
    const reopened = new TransportLog({ root, now: () => 2000 });
    const page = await reopened.page();
    expect(page.records.map((r) => r.id)).toEqual(["a", "b"]);
    // the cleaned view is persisted back
    const cleaned = await readFile(logFile(), "utf8");
    expect(cleaned.split("\n").filter((line) => line !== "")).toHaveLength(2);
  });

  test("prune applies the double cap (age + count)", async () => {
    let now = 1000;
    const log = new TransportLog({ root, retain: { ageMs: 500, count: 2 }, now: () => now });
    await log.append(record("old", { ts: 100 }));
    await log.append(record("mid", { ts: 900 }));
    await log.append(record("new", { ts: 1000 }));
    now = 1400; // age floor 900: "old" expired; count cap 2 keeps the newest two
    await log.prune();
    expect((await log.page()).records.map((r) => r.id)).toEqual(["mid", "new"]);
  });

  test("append never throws — a log failure must not fail the route", async () => {
    // a root whose observe/ path is a FILE → mkdir/append fail inside
    const log = new TransportLog({ root: join(root, "missing") });
    await writeFile(join(root, "missing"), "not a dir", "utf8").catch(() => undefined);
    // root itself is a file → every fs op under it fails; append still resolves
    expect(await log.append(record("a"))).toBe(false);
  });

  test("listFiles exposes the log to blob GC only once it exists", async () => {
    const log = new TransportLog({ root });
    expect(await log.listFiles()).toEqual([]);
    await log.append(record("a"));
    expect(await log.listFiles()).toEqual([logFile()]);
  });
});
