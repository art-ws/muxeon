import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@muxeon/core";
import { type QueuePaths, dequeue, enqueue, ensureQueueDirs, queuePaths } from "@muxeon/queue";
import { EgressDispatcher } from "../src/egress";

let root: string;
let paths: QueuePaths;
let seq: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-egress-"));
  paths = queuePaths(root, "operator");
  await ensureQueueDirs(paths);
  seq = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function msg(id: string): Message {
  return { id, from: "agent", to: "operator", kind: "message", ts: 0, payload: id };
}

async function put(id: string): Promise<void> {
  seq += 1;
  await enqueue(paths, { unixMs: 1700000000000, seq, fileId: id, message: msg(id) });
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function makeEgress(doneIds = new Set<string>()): EgressDispatcher {
  return new EgressDispatcher({ paths, doneIds });
}

describe("egress dispatcher (§5.3, §8.2, §10.8/§10.9, FR-37)", () => {
  test("dequeue → deliver → complete(done) immediately, in FIFO order", async () => {
    const delivered: string[] = [];
    const egress = makeEgress();
    egress.registerDeliver(async (m) => {
      delivered.push(m.id);
    });
    await put("a");
    await put("b");
    await put("c");
    expect(await egress.pump()).toBe(3);
    expect(delivered).toEqual(["a", "b", "c"]);
    expect(jsonFiles(paths.done)).toHaveLength(3);
    expect(jsonFiles(paths.cur)).toHaveLength(0); // cur is transitory
    expect(jsonFiles(paths.pending)).toHaveLength(0);
  });

  test("pending accumulates until the deliver port is registered (NFR-4)", async () => {
    const egress = makeEgress();
    await put("a");
    await put("b");
    expect(await egress.pump()).toBe(0); // no port yet — nothing is touched
    await egress.recover();
    expect(jsonFiles(paths.pending)).toHaveLength(2); // no loss
    const delivered: string[] = [];
    egress.registerDeliver(async (m) => {
      delivered.push(m.id);
    });
    expect(await egress.pump()).toBe(2); // drains on registration
    expect(delivered).toEqual(["a", "b"]);
  });

  test("a second deliver registration is rejected (one operator — one channel, §7.5)", () => {
    const egress = makeEgress();
    egress.registerDeliver(async () => undefined);
    expect(() => egress.registerDeliver(async () => undefined)).toThrow(/already registered/);
  });

  test("a deliver that throws leaves the record in cur/ for re-send (§10.9)", async () => {
    let healthy = false;
    const delivered: string[] = [];
    const egress = makeEgress();
    egress.registerDeliver(async (m) => {
      if (!healthy) throw new Error("channel down");
      delivered.push(m.id);
    });
    await put("a");
    await put("b");
    expect(await egress.pump()).toBe(0); // push failed
    expect(jsonFiles(paths.cur)).toHaveLength(1); // a stuck under re-send
    expect(jsonFiles(paths.pending)).toHaveLength(1); // b blocked behind it (FIFO)
    expect(await egress.pump()).toBe(0); // cur occupied → nothing new is claimed
    healthy = true;
    await egress.recover(); // re-sends the stuck cur/ record in place
    expect(await egress.pump()).toBe(1);
    expect(delivered).toEqual(["a", "b"]); // at-least-once, order preserved
    expect(jsonFiles(paths.done)).toHaveLength(2);
  });

  test("|cur| ≤ 1 during every push (§10.8)", async () => {
    const curCounts: number[] = [];
    const egress = makeEgress();
    egress.registerDeliver(async () => {
      curCounts.push(jsonFiles(paths.cur).length);
    });
    await put("a");
    await put("b");
    await egress.pump();
    expect(curCounts).toEqual([1, 1]);
  });

  test("recovery re-sends a cur/ record left by a crash before done/ (§10.9)", async () => {
    await put("a");
    await dequeue(paths); // claimed into cur/, then "crash" before the done/ rename
    const delivered: string[] = [];
    const egress = makeEgress();
    egress.registerDeliver(async (m) => {
      delivered.push(m.id);
    });
    await egress.recover();
    expect(delivered).toEqual(["a"]); // duplicate push possible — acceptable (§5.3)
    expect(jsonFiles(paths.done)).toHaveLength(1);
    expect(jsonFiles(paths.cur)).toHaveLength(0);
  });

  test("a re-enqueued done id is dropped (dedup window, §10.9)", async () => {
    const doneIds = new Set<string>();
    const egress = makeEgress(doneIds);
    const delivered: string[] = [];
    egress.registerDeliver(async (m) => {
      delivered.push(m.id);
    });
    await put("dup");
    await egress.pump();
    await put("dup"); // producer retry with the same logical id
    expect(await egress.pump()).toBe(0);
    expect(delivered).toEqual(["dup"]); // pushed once
    expect(jsonFiles(paths.pending)).toHaveLength(0); // duplicate dropped
  });

  test("run() recovers, drains, and keeps pumping until aborted", async () => {
    await put("a");
    await dequeue(paths); // in-flight from a previous run
    await put("b");
    const delivered: string[] = [];
    const controller = new AbortController();
    const egress = new EgressDispatcher({
      paths,
      doneIds: new Set(),
      sleep: async () => {
        controller.abort(); // first idle tick → stop
      },
    });
    egress.registerDeliver(async (m) => {
      delivered.push(m.id);
    });
    await egress.run(controller.signal);
    expect(delivered).toEqual(["a", "b"]);
    expect(jsonFiles(paths.done)).toHaveLength(2);
    expect(jsonFiles(paths.cur)).toHaveLength(0);
    expect(jsonFiles(paths.pending)).toHaveLength(0);
  });
});
