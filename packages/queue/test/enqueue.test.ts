import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, parseQueueName } from "@muxeon/core";
import { enqueue } from "../src/enqueue";
import { ensureQueueDirs, queuePaths } from "../src/layout";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-queue-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function msg(id: string): Message {
  return { id, from: "a", to: "b", kind: "message", ts: 1700000000000, payload: { text: "hi" } };
}

describe("queue layout + enqueue (§5.3, FR-12/14/15)", () => {
  test("ensureQueueDirs creates the maildir subdirs on one filesystem", async () => {
    const paths = queuePaths(root, "researcher-session");
    await ensureQueueDirs(paths);
    for (const sub of [paths.tmp, paths.pending, paths.cur, paths.done, paths.failed]) {
      expect(statSync(sub).isDirectory()).toBe(true);
    }
    // tmp and pending must share a filesystem so the move is an atomic rename (§5.3):
    expect(statSync(paths.tmp).dev).toBe(statSync(paths.pending).dev);
  });

  test("enqueue atomically lands a message in pending and clears tmp", async () => {
    const paths = queuePaths(root, "s");
    await ensureQueueDirs(paths);
    const filename = await enqueue(paths, {
      unixMs: 1700000000000,
      seq: 0,
      fileId: "abc",
      message: msg("logical-id"),
    });
    expect(readdirSync(paths.pending)).toEqual([filename]);
    expect(readdirSync(paths.tmp)).toEqual([]);
    const stored = JSON.parse(readFileSync(join(paths.pending, filename), "utf8")) as Message;
    expect(stored.id).toBe("logical-id"); // logical id preserved in the body
    expect(parseQueueName(filename).id).toBe("abc"); // sanitized id in the name
  });

  test("concurrent producers neither lose nor duplicate records", async () => {
    const paths = queuePaths(root, "s");
    await ensureQueueDirs(paths);
    const count = 100;
    await Promise.all(
      Array.from({ length: count }, (_value, i) =>
        enqueue(paths, { unixMs: 1700000000000, seq: i, fileId: `id${i}`, message: msg(`id${i}`) }),
      ),
    );
    const files = readdirSync(paths.pending);
    expect(files).toHaveLength(count);
    expect(new Set(files).size).toBe(count); // every filename is unique
    // names sort to FIFO by seq:
    const seqs = files.map((f) => parseQueueName(f).seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: count }, (_value, i) => i));
  });

  test("enqueue rejects an unsafe file id (§8.7 boundary)", async () => {
    const paths = queuePaths(root, "s");
    await ensureQueueDirs(paths);
    await expect(
      enqueue(paths, { unixMs: 1, seq: 0, fileId: "../escape", message: msg("x") }),
    ).rejects.toThrow();
  });
});
