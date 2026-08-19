import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { TransportLog, windowAround } from "../src/transport-log";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muxeon-transport-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(id: string, overrides: Partial<Signal> = {}): Signal {
  return {
    id,
    from: "muxeon",
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
    await log.append(record("x-1", { from: "muxeon", to: "sherlock", ts: now + 1 }));
    await log.append(record("p-2", { from: "qwen", to: "muxeon", ts: now + 2 }));
    await log.append(record("x-2", { from: "sherlock", to: "qwen", ts: now + 3 }));
    await log.append(record("p-3", { ts: now + 4 }));
    expect((await log.pair("muxeon", "qwen", 50)).map((r) => r.id)).toEqual(["p-1", "p-2", "p-3"]);
    expect((await log.pair("qwen", "muxeon", 50)).map((r) => r.id)).toEqual(["p-1", "p-2", "p-3"]); // symmetric
  });

  test("the depth limit keeps the NEWEST records", async () => {
    const log = new TransportLog({ root });
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) await log.append(record(`d-${i}`, { ts: now + i }));
    expect((await log.pair("muxeon", "qwen", 2)).map((r) => r.id)).toEqual(["d-3", "d-4"]);
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
    expect(await log.append(record("b", { from: "qwen", to: "muxeon" }))).toBe(true);
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

// --- amortized trimming (T287) --------------------------------------------------
// The count cap bounds the log; it never promised an exact length. Trimming AT the
// cap made every append past it rewrite the whole journal — O(log) per routed
// signal, megabytes of garbage each. The slack is what keeps the append O(1).

describe("TransportLog inline count cap (T287)", () => {
  const lines = async (): Promise<string[]> =>
    (await readFile(logFile(), "utf8")).split("\n").filter((line) => line !== "");
  // Fresh timestamps: the default age cap is 90 days, and the shared `record`
  // helper stamps ts: 1000 — old enough that the age sweep would eat everything.
  const fresh = (id: string, i: number): Signal => record(id, { ts: Date.now() + i });
  // count 20 ⇒ slack 2 ⇒ the append path trims once the log passes 22.
  const fill = async (log: TransportLog, upTo: number): Promise<void> => {
    for (let i = 0; i < upTo; i += 1) await log.append(fresh(`r-${i}`, i));
  };

  test("runs into the slack before trimming, then trims back to the cap", async () => {
    const log = new TransportLog({ root, retain: { count: 20 } });
    await fill(log, 22);
    // past the cap and NOT yet rewritten — this is the amortization
    expect(await lines()).toHaveLength(22);

    await log.append(fresh("r-22", 22));
    expect(await lines()).toHaveLength(20);
    // the oldest records went, the newest survived, order preserved
    const ids = (await log.page({ limit: 100 })).records.map((r) => r.id);
    expect(ids[0]).toBe("r-3");
    expect(ids.at(-1)).toBe("r-22");
  });

  test("an append does not rewrite the file — only the trim does", async () => {
    // A rewrite is tmp+rename, so it replaces the inode; appendFile keeps it.
    // Watching the inode is exactly how the O(log)-per-append bug was found.
    const log = new TransportLog({ root, retain: { count: 20 } });
    await fill(log, 21);
    const settled = (await stat(logFile())).ino;

    await log.append(fresh("within-slack", 21));
    expect((await stat(logFile())).ino).toBe(settled); // appended, not rewritten

    await log.append(fresh("over-slack", 22));
    expect((await stat(logFile())).ino).not.toBe(settled); // the one trim
  });

  // The sweep needs the slack MORE than append does: it runs on a 60 s clock, so
  // an exact cap costs one full-log rewrite per minute for as long as any traffic
  // arrives — on a stand seeing a few messages a minute that is per-message again.
  test("the sweep honours the slack too, and cuts to exactly the cap past it", async () => {
    const log = new TransportLog({ root, retain: { count: 20 } });
    await fill(log, 22);
    const settled = (await stat(logFile())).ino;

    await log.prune(); // within the slack — nothing to do, nothing rewritten
    expect(await lines()).toHaveLength(22);
    expect((await stat(logFile())).ino).toBe(settled);

    await log.append(fresh("r-22", 22)); // 23 > trimAt ⇒ the append trims
    await log.prune();
    expect(await lines()).toHaveLength(20);
  });

  test("the age cap stays exact on the sweep — the slack is the count cap only", async () => {
    let now = 10_000;
    const log = new TransportLog({ root, retain: { ageMs: 500, count: 20 }, now: () => now });
    await log.append(record("stale", { ts: now - 600 })); // already past the floor
    await log.append(record("fresh", { ts: now }));
    now = 10_050; // floor 9_550: "stale" expired and goes despite the count slack
    await log.prune();
    expect((await log.page()).records.map((r) => r.id)).toEqual(["fresh"]);
  });
});

// A quoted message is resolved BY ID (FR-179, T292): the agent is handed a
// `replyTo=` and reads it — plus the turns around it — out of its own pair.
describe("the window around a quoted message", () => {
  const pairLog = async (): Promise<TransportLog> => {
    const log = new TransportLog({ root });
    for (let i = 0; i < 6; i += 1) {
      await log.append(record(`p${i}`, { from: "operator", to: "dev", ts: 1000 + i }));
      await log.append(record(`o${i}`, { from: "other", to: "dev", ts: 1000 + i })); // a different pair
    }
    return log;
  };

  test("centres on the id — context before AND after, this pair only", async () => {
    const log = await pairLog();
    const ids = (await log.pair("dev", "operator", 3, "p3")).map((r) => r.id);
    expect(ids).toEqual(["p2", "p3", "p4"]);
  });

  test("a target near the start still returns a FULL window", async () => {
    const log = await pairLog();
    expect((await log.pair("dev", "operator", 3, "p0")).map((r) => r.id)).toEqual([
      "p0",
      "p1",
      "p2",
    ]);
    expect((await log.pair("dev", "operator", 3, "p5")).map((r) => r.id)).toEqual([
      "p3",
      "p4",
      "p5",
    ]);
  });

  test("an id outside this pair is EMPTY — never the newest records instead", async () => {
    const log = await pairLog();
    expect(await log.pair("dev", "operator", 5, "o2")).toEqual([]); // another pair's record
    expect(await log.pair("dev", "operator", 5, "nope")).toEqual([]);
  });

  test("without an id the tail is unchanged (FR-87)", async () => {
    const log = await pairLog();
    expect((await log.pair("dev", "operator", 2)).map((r) => r.id)).toEqual(["p4", "p5"]);
  });
});

describe("windowAround", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  test("an even limit leans on the side with more to say", () => {
    expect(windowAround(items, 5, 4)).toEqual([4, 5, 6, 7]);
  });

  test("a limit past the length returns everything", () => {
    expect(windowAround([1, 2], 1, 9)).toEqual([1, 2]);
  });

  test("nonsense in, nothing out", () => {
    expect(windowAround(items, -1, 3)).toEqual([]);
    expect(windowAround(items, 3, 0)).toEqual([]);
    expect(windowAround(items, 99, 3)).toEqual([]);
  });
});
