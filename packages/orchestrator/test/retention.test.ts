// Retention sweep (§5.4) at the orchestrator level: pruning done/ NARROWS the
// live dedup window (§10.9) — a logical id whose archive record was pruned is
// processed again on re-enqueue, exactly the documented weakening.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRender } from "@muxeon/adapters";
import type { Message } from "@muxeon/core";
import { type QueuePaths, enqueue, ensureQueueDirs, queuePaths } from "@muxeon/queue";
import { Dispatcher } from "../src/dispatcher";
import { createRetention } from "../src/retention";
import { AgentState } from "../src/status";

let root: string;
let paths: QueuePaths;
let seq: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-retention-"));
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
  await enqueue(paths, { unixMs: Date.now(), seq, fileId: id, message: msg(id) });
}

test("pruning done/ shrinks the dedup window: the id is processed again (§10.9)", async () => {
  const injected: string[] = [];
  const doneIds = new Set<string>();
  const dispatcher = new Dispatcher({
    paths,
    driver: {
      inject: async (text) => {
        injected.push(text);
      },
      awaitTurn: async () => undefined,
    },
    render: defaultRender,
    state: new AgentState("idle"),
    doneIds,
  });
  const retention = createRetention({
    root,
    targets: [
      {
        session: "s",
        policy: { ageMs: 0, count: 0 }, // prune everything — maximal shrink
        forgetDone: (ids) => dispatcher.forgetDone(ids),
      },
    ],
    blobAgeMs: 0,
  });

  await put("dup");
  await dispatcher.pump();
  expect(doneIds.has("dup")).toBe(true);

  await put("dup"); // within the window → dropped (§10.9)
  expect(await dispatcher.pump()).toBe(0);
  expect(injected).toHaveLength(1);

  await retention.sweep(); // done/ pruned → window narrowed (§5.4)
  expect(doneIds.has("dup")).toBe(false);
  expect(readdirSync(paths.done).filter((f) => f.endsWith(".json"))).toHaveLength(0);

  await put("dup"); // beyond the window → processed again, as documented
  expect(await dispatcher.pump()).toBe(1);
  expect(injected).toHaveLength(2);
});

test("run() sweeps on its cadence until aborted", async () => {
  const controller = new AbortController();
  let sweeps = 0;
  const retention = createRetention({
    root,
    targets: [{ session: "s", policy: { ageMs: 0, count: 0 }, forgetDone: () => undefined }],
    blobAgeMs: 0,
    sleep: async () => {
      sweeps += 1;
      if (sweeps >= 3) controller.abort();
    },
  });
  await retention.run(controller.signal);
  expect(sweeps).toBe(3);
});
