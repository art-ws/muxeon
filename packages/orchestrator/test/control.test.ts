import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRender } from "@muxeon/adapters";
import type { Message } from "@muxeon/core";
import { type QueuePaths, enqueue, ensureQueueDirs, queuePaths } from "@muxeon/queue";
import { ControlLane } from "../src/control";
import { Dispatcher, type SessionDriver } from "../src/dispatcher";
import { AgentState } from "../src/status";

describe("ControlLane (§8.5)", () => {
  test("submit resolves with the op result once drained, in order", async () => {
    const lane = new ControlLane();
    const order: string[] = [];
    const a = lane.submit(async () => {
      order.push("a");
      return 1;
    });
    const b = lane.submit(async () => {
      order.push("b");
      return 2;
    });
    expect(lane.size).toBe(2);
    expect(await lane.drain()).toBe(2);
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(order).toEqual(["a", "b"]);
    expect(lane.size).toBe(0);
  });

  test("a throwing op rejects its submitter but does not break the lane", async () => {
    const lane = new ControlLane();
    const failing = lane.submit(async () => {
      throw new Error("op boom");
    });
    const ok = lane.submit(async () => "fine");
    await lane.drain();
    await expect(failing).rejects.toThrow("op boom");
    expect(await ok).toBe("fine");
  });
});

describe("control ops run in the dispatcher loop between turns (§8.5, §10.8)", () => {
  let root: string;
  let paths: QueuePaths;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "muxeon-control-"));
    paths = queuePaths(root, "s");
    await ensureQueueDirs(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function msg(id: string): Message {
    return { id, from: "a", to: "b", kind: "message", ts: 0, payload: id };
  }

  test("an op submitted mid-pump applies between turns, never inside one", async () => {
    let seq = 0;
    const put = async (id: string): Promise<void> => {
      seq += 1;
      await enqueue(paths, { unixMs: 1700000000000, seq, fileId: id, message: msg(id) });
    };
    await put("a");
    await put("b");

    const lane = new ControlLane();
    const events: string[] = [];
    let inTurn = false;
    const driver: SessionDriver = {
      inject: async () => undefined,
      awaitTurn: async () => {
        inTurn = true;
        // submitted DURING a turn — must not run until the turn completes
        if (events.length === 0) {
          void lane.submit(async () => {
            events.push(`op(inTurn=${inTurn})`);
          });
        }
        inTurn = false;
        events.push("turn");
      },
    };
    const dispatcher = new Dispatcher({
      paths,
      driver,
      render: defaultRender,
      state: new AgentState("idle"),
      doneIds: new Set(),
      control: lane,
    });
    await dispatcher.pump();
    expect(events).toEqual(["turn", "op(inTurn=false)", "turn"]); // serialized between turns
  });

  test("ops drain in run() even while the agent is down (e.g. a provision op)", async () => {
    const lane = new ControlLane();
    const state = new AgentState("down");
    const controller = new AbortController();
    const dispatcher = new Dispatcher({
      paths,
      driver: { inject: async () => undefined, awaitTurn: async () => undefined },
      render: defaultRender,
      state,
      doneIds: new Set(),
      control: lane,
      sleep: async () => {
        controller.abort();
      },
    });
    const op = lane.submit(async () => "ran while down");
    await dispatcher.run(controller.signal);
    expect(await op).toBe("ran while down");
  });
});
