import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@muxeon/core";
import { complete } from "../src/complete";
import { loadDoneIds } from "../src/dedup";
import { dequeue } from "../src/dequeue";
import { enqueue } from "../src/enqueue";
import { queueDepth } from "../src/inspect";
import { type QueuePaths, ensureQueueDirs, queuePaths } from "../src/layout";
import { readCur } from "../src/recovery";

let root: string;
let paths: QueuePaths;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-queue-ops-"));
  paths = queuePaths(root, "s");
  await ensureQueueDirs(paths);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function msg(id: string): Message {
  return { id, from: "a", to: "b", kind: "message", ts: 1, payload: id };
}

async function put(seq: number, id: string): Promise<void> {
  await enqueue(paths, { unixMs: 1700000000000, seq, fileId: id, message: msg(id) });
}

function take<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value");
  return value;
}

describe("dequeue / complete / recovery / dedup (§5.3, §10.1/§10.8/§10.9)", () => {
  test("dequeue claims the oldest pending into the single cur slot (FIFO)", async () => {
    await put(2, "c");
    await put(0, "a");
    await put(1, "b");
    const item = take(await dequeue(paths));
    expect(item.message.id).toBe("a"); // smallest seq wins
    expect(readdirSync(paths.cur)).toHaveLength(1);
    expect(readdirSync(paths.pending)).toHaveLength(2);
  });

  test("a non-empty cur blocks a new dequeue (|cur| ≤ 1, §10.1/§10.8)", async () => {
    await put(0, "a");
    await put(1, "b");
    const first = take(await dequeue(paths));
    expect(await dequeue(paths)).toBeNull(); // busy — nothing new
    expect(readdirSync(paths.cur)).toHaveLength(1);
    await complete(paths, first.filename, "done");
    expect(take(await dequeue(paths)).message.id).toBe("b"); // freed
  });

  test("complete moves cur → done (success) or failed (render/inject error, FR-35b)", async () => {
    await put(0, "a");
    const a = take(await dequeue(paths));
    await complete(paths, a.filename, "done");
    expect(readdirSync(paths.done)).toEqual([a.filename]);
    expect(readdirSync(paths.cur)).toEqual([]);

    await put(1, "b");
    const b = take(await dequeue(paths));
    await complete(paths, b.filename, "failed");
    expect(readdirSync(paths.failed)).toEqual([b.filename]);
    expect(readdirSync(paths.cur)).toEqual([]);
  });

  test("queueDepth counts pending + the cur slot, ignoring done/failed (§8.2 WIP, FR-104)", async () => {
    expect(await queueDepth(paths)).toBe(0);
    await put(0, "a");
    await put(1, "b");
    expect(await queueDepth(paths)).toBe(2); // both pending
    const a = take(await dequeue(paths)); // a → cur, b still pending
    expect(await queueDepth(paths)).toBe(2); // 1 cur + 1 pending
    await complete(paths, a.filename, "done"); // a → done (terminal, not counted)
    expect(await queueDepth(paths)).toBe(1); // just b in pending
  });

  test("complete is idempotent: a second complete of an already-moved file is a no-op, not a throw (T169)", async () => {
    await put(0, "a");
    const a = take(await dequeue(paths));
    await complete(paths, a.filename, "done"); // cur → done
    // A redelivery/recovery race re-completes the same cur/ file (source gone).
    // ENOENT must resolve as a no-op — never an unhandled rejection (§10.8/§5.3).
    await complete(paths, a.filename, "done");
    expect(readdirSync(paths.done)).toEqual([a.filename]);
    expect(readdirSync(paths.cur)).toEqual([]);
    expect(readdirSync(paths.failed)).toEqual([]);
  });

  test("recovery: a file left in cur after a crash is re-readable in place (§10.9)", async () => {
    await put(0, "a");
    const claimed = take(await dequeue(paths)); // crash AFTER claim, BEFORE complete
    const recovered = take(await readCur(paths)); // "restart" inspects cur/
    expect(recovered.filename).toBe(claimed.filename);
    expect(recovered.message.id).toBe("a");
    expect(readdirSync(paths.cur)).toHaveLength(1); // still in place for re-send
  });

  test("readCur returns null when nothing is in flight", async () => {
    expect(await readCur(paths)).toBeNull();
  });

  test("a repeated id already in done/ is dropped at dequeue (§10.9)", async () => {
    await put(0, "dup");
    const first = take(await dequeue(paths));
    await complete(paths, first.filename, "done");
    const doneIds = await loadDoneIds(paths);
    expect(doneIds.has("dup")).toBe(true);

    await put(1, "dup"); // producer re-enqueues the same logical id
    expect(await dequeue(paths, { skipIds: doneIds })).toBeNull(); // duplicate dropped
    expect(readdirSync(paths.pending)).toEqual([]); // and removed from pending
  });

  test("dedup skips a duplicate but still claims a following distinct message", async () => {
    await put(0, "dup");
    await complete(paths, take(await dequeue(paths)).filename, "done");
    const doneIds = await loadDoneIds(paths);

    await put(1, "dup"); // duplicate (older)
    await put(2, "fresh"); // distinct (newer)
    const item = take(await dequeue(paths, { skipIds: doneIds }));
    expect(item.message.id).toBe("fresh");
    expect(readdirSync(paths.pending)).toEqual([]); // dup dropped, fresh claimed
  });

  test("dequeue on an empty queue returns null", async () => {
    expect(await dequeue(paths)).toBeNull();
  });
});
