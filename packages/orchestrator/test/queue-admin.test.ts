import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@muxeon/core";
import {
  type QueuePaths,
  complete,
  dequeue,
  enqueue,
  ensureQueueDirs,
  queuePaths,
} from "@muxeon/queue";
import { cancelPendingById, isQueuedById, peekQueue, requeueFailedById } from "../src/queue-admin";

let root: string;
let paths: QueuePaths;
let seq: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-queue-admin-"));
  paths = queuePaths(root, "s");
  await ensureQueueDirs(paths);
  seq = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function msg(id: string): Message {
  return { id, from: "a", to: "b", kind: "message", ts: 0, payload: id };
}

async function put(id: string): Promise<void> {
  seq += 1;
  await enqueue(paths, { unixMs: 1700000000000, seq, fileId: id, message: msg(id) });
}

describe("queue admin ops (§8.5, §10.8/§10.9)", () => {
  test("peek lists pending (FIFO order) and cur", async () => {
    await put("a");
    await put("b");
    const claimed = await dequeue(paths); // a → cur
    expect(claimed?.message.id).toBe("a");
    const peeked = await peekQueue(paths);
    expect(peeked.cur.map((e) => e.message.id)).toEqual(["a"]);
    expect(peeked.pending.map((e) => e.message.id)).toEqual(["b"]);
  });

  test("cancel removes a pending record by logical id", async () => {
    await put("a");
    await put("b");
    expect(await cancelPendingById(paths, "a")).toBe("cancelled");
    const peeked = await peekQueue(paths);
    expect(peeked.pending.map((e) => e.message.id)).toEqual(["b"]);
  });

  test("cancel of an id already claimed into cur/ is refused (§8.5)", async () => {
    await put("a");
    await dequeue(paths);
    expect(await cancelPendingById(paths, "a")).toBe("in-flight");
    expect((await peekQueue(paths)).cur).toHaveLength(1); // untouched
  });

  test("cancel of an unknown id → not-found", async () => {
    expect(await cancelPendingById(paths, "ghost")).toBe("not-found");
  });

  test("requeue moves failed → pending tail with a fresh stamp, same logical id (§10.9)", async () => {
    await put("x");
    const claimed = await dequeue(paths);
    if (claimed === null) throw new Error("expected a claim");
    await complete(paths, claimed.filename, "failed"); // render/inject error path (FR-35b)
    await put("y"); // already waiting in pending

    const result = await requeueFailedById(
      paths,
      "x",
      { unixMs: 1700000099999, seq: 50 },
      new Set(),
    );
    expect(result.outcome).toBe("requeued");
    const peeked = await peekQueue(paths);
    // y (older stamp) first; the requeued x joined the tail (§5.3 FIFO)
    expect(peeked.pending.map((e) => e.message.id)).toEqual(["y", "x"]);
    expect(readdirSync(paths.failed).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  test("requeue of an id in the done/ window → explicit no-op (§8.5/§10.9)", async () => {
    const result = await requeueFailedById(
      paths,
      "done-id",
      { unixMs: 1, seq: 1 },
      new Set(["done-id"]),
    );
    expect(result).toEqual({ outcome: "already-done" });
  });

  test("requeue of an unknown id → not-found", async () => {
    const result = await requeueFailedById(paths, "ghost", { unixMs: 1, seq: 1 }, new Set());
    expect(result).toEqual({ outcome: "not-found" });
  });
});

// §10.15 (T374): the rendezvous coordinator asks whether its last notice still
// waits in the target's queue — by the LOGICAL id, which a file name only
// approximates (`rv:a:b:0` is stored as `…-rv_a_b_0.json`).
describe("isQueuedById (§10.15)", () => {
  async function putRaw(id: string): Promise<void> {
    seq += 1;
    await enqueue(paths, {
      unixMs: 1700000000000,
      seq,
      fileId: id.replace(/[^A-Za-z0-9_-]/g, "_"),
      message: msg(id),
    });
  }

  test("pending and the running turn count as queued; done and unknown do not", async () => {
    await putRaw("rv:a:b:0");
    expect(await isQueuedById(paths, "rv:a:b:0")).toBe(true);
    expect(await isQueuedById(paths, "rv_a_b_0")).toBe(false); // the file name is not the id
    const item = await dequeue(paths); // B starts the turn: pending → cur
    expect(item).not.toBeNull();
    expect(await isQueuedById(paths, "rv:a:b:0")).toBe(true);
    if (item !== null) await complete(paths, item.filename, "done");
    expect(await isQueuedById(paths, "rv:a:b:0")).toBe(false);
    expect(await isQueuedById(queuePaths(root, "missing"), "rv:a:b:0")).toBe(false);
  });
});
