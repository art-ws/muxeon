import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@muxeon/core";
import { ensureBlobDirs, writeBlob } from "../src/blobs";
import { gcBlobs } from "../src/gc";
import { complete, dequeue, enqueue, ensureQueueDirs, queuePaths } from "../src/index";
import type { QueuePaths } from "../src/layout";
import { parseRetainAge, pruneArchive } from "../src/retain";

const NOW = 1_700_000_600_000;

let root: string;
let paths: QueuePaths;
let seq: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-retain-"));
  paths = queuePaths(root, "s");
  await ensureQueueDirs(paths);
  await ensureBlobDirs(root);
  seq = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function msg(id: string, payload: unknown = id): Message {
  return { id, from: "a", to: "b", kind: "message", ts: 0, payload };
}

/** Enqueue + complete into done/ (or failed/) with a controlled unix_ms age. */
async function archive(
  id: string,
  ageMs: number,
  sub: "done" | "failed" = "done",
  payload?: unknown,
) {
  seq += 1;
  await enqueue(paths, { unixMs: NOW - ageMs, seq, fileId: id, message: msg(id, payload) });
  const item = await dequeue(paths);
  if (item === null) throw new Error("expected a claim");
  await complete(paths, item.filename, sub);
}

const jsonFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("parseRetainAge (§7.1)", () => {
  test("parses each unit", () => {
    expect(parseRetainAge("500ms")).toBe(500);
    expect(parseRetainAge("45s")).toBe(45_000);
    expect(parseRetainAge("30m")).toBe(1_800_000);
    expect(parseRetainAge("12h")).toBe(43_200_000);
    expect(parseRetainAge("7d")).toBe(604_800_000);
  });

  test("rejects malformed values", () => {
    expect(() => parseRetainAge("7")).toThrow(/invalid retain.age/);
    expect(() => parseRetainAge("1w")).toThrow(/invalid retain.age/);
    expect(() => parseRetainAge("")).toThrow(/invalid retain.age/);
  });
});

describe("done/failed pruning — the double cap (§5.4, FR-34)", () => {
  test("prunes by age: older than retain.age goes, younger stays", async () => {
    await archive("old", 10_000);
    await archive("young", 1_000);
    const removed = await pruneArchive(paths, "done", { ageMs: 5_000, count: 100 }, NOW);
    expect(removed).toEqual(["old"]);
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });

  test("prunes by count: only the newest `count` survive (oldest removed first)", async () => {
    await archive("a", 4_000);
    await archive("b", 3_000);
    await archive("c", 2_000);
    const removed = await pruneArchive(paths, "done", { ageMs: 999_999, count: 2 }, NOW);
    expect(removed).toEqual(["a"]);
    expect(jsonFiles(paths.done)).toHaveLength(2);
  });

  test("both caps apply together (age OR count)", async () => {
    await archive("ancient", 50_000); // over age
    await archive("b", 3_000);
    await archive("c", 2_000);
    await archive("d", 1_000);
    const removed = await pruneArchive(paths, "done", { ageMs: 10_000, count: 2 }, NOW);
    expect(removed.sort()).toEqual(["ancient", "b"]); // ancient by age, b by count
    expect(jsonFiles(paths.done)).toHaveLength(2);
  });

  test("failed/ prunes independently of done/ (§5.4)", async () => {
    await archive("ok", 10_000, "done");
    await archive("bad", 10_000, "failed");
    const removed = await pruneArchive(paths, "failed", { ageMs: 5_000, count: 100 }, NOW);
    expect(removed).toEqual(["bad"]);
    expect(jsonFiles(paths.done)).toHaveLength(1); // done untouched
    expect(jsonFiles(paths.failed)).toHaveLength(0);
  });
});

describe("blob GC (§5.4)", () => {
  function ageBlob(id: string, ageMs: number): void {
    const at = new Date(NOW - ageMs);
    utimesSync(join(root, "blobs", id), at, at);
  }

  test("collects an unreferenced blob older than the age floor", async () => {
    const id = await writeBlob(root, new TextEncoder().encode("orphan"));
    ageBlob(id, 10_000);
    expect(await gcBlobs({ root, sessions: ["s"], ageMs: 5_000, now: () => NOW })).toEqual([id]);
  });

  test("keeps a blob referenced from any record sub-state", async () => {
    const id = await writeBlob(root, new TextEncoder().encode("attached"));
    ageBlob(id, 10_000);
    await archive("with-blob", 1_000, "done", { blobs: [{ blob: id }] });
    expect(await gcBlobs({ root, sessions: ["s"], ageMs: 5_000, now: () => NOW })).toEqual([]);
    expect(readdirSync(join(root, "blobs"))).toContain(id);
  });

  test("keeps a young blob even when unreferenced — the §5.4 enqueue-gap floor", async () => {
    const id = await writeBlob(root, new TextEncoder().encode("fresh"));
    ageBlob(id, 1_000);
    expect(await gcBlobs({ root, sessions: ["s"], ageMs: 5_000, now: () => NOW })).toEqual([]);
  });

  test("keeps a blob referenced only from an extra source (webchat history, §12.3)", async () => {
    const id = await writeBlob(root, new TextEncoder().encode("in-history"));
    ageBlob(id, 10_000);
    const log = join(root, "history.jsonl"); // any file outside the queues
    writeFileSync(log, `${JSON.stringify({ id: "h-1", payload: { blobs: [{ blob: id }] } })}\n`);
    expect(
      await gcBlobs({
        root,
        sessions: ["s"],
        ageMs: 5_000,
        extraRefFiles: async () => [log],
        now: () => NOW,
      }),
    ).toEqual([]);
    expect(readdirSync(join(root, "blobs"))).toContain(id);
    // the history line gone (pruned) → the next sweep collects it
    rmSync(log);
    expect(
      await gcBlobs({
        root,
        sessions: ["s"],
        ageMs: 5_000,
        extraRefFiles: async () => [log],
        now: () => NOW,
      }),
    ).toEqual([id]);
  });

  test("never touches the tmp staging dir", async () => {
    writeFileSync(join(root, "blobs", "tmp", "half-written"), "…");
    const at = new Date(NOW - 999_999);
    utimesSync(join(root, "blobs", "tmp", "half-written"), at, at);
    await gcBlobs({ root, sessions: ["s"], ageMs: 5_000, now: () => NOW });
    expect(readdirSync(join(root, "blobs", "tmp"))).toContain("half-written");
  });

  test("a pruned reference frees the blob on the NEXT sweep (GC tied to pruning)", async () => {
    const id = await writeBlob(root, new TextEncoder().encode("soon-orphan"));
    ageBlob(id, 60_000);
    await archive("carrier", 30_000, "done", { blobs: [{ blob: id }] });
    // sweep 1: record still references the blob
    expect(await gcBlobs({ root, sessions: ["s"], ageMs: 5_000, now: () => NOW })).toEqual([]);
    // prune the carrier, then sweep again — now unreferenced and old
    await pruneArchive(paths, "done", { ageMs: 10_000, count: 100 }, NOW);
    expect(await gcBlobs({ root, sessions: ["s"], ageMs: 5_000, now: () => NOW })).toEqual([id]);
  });
});
