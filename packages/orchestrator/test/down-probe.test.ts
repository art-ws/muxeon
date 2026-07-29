import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@teamai/core";
import { type QueuePaths, enqueue, ensureQueueDirs, queuePaths } from "@teamai/queue";
import { Dispatcher, type SessionDriver } from "../src/dispatcher";
import { waitForSessionDown } from "../src/down-probe";
import { AgentState } from "../src/status";

const noSleep = async (): Promise<void> => undefined;

describe("waitForSessionDown (§5.1, FR-16b)", () => {
  test("resolves once the session is confirmed absent", async () => {
    let calls = 0;
    await waitForSessionDown("s", new AbortController().signal, {
      hasSession: async () => {
        calls += 1;
        return calls < 3; // present twice, then gone
      },
      sleep: noSleep,
    });
    expect(calls).toBe(3);
  });

  test("stops without resolving down when aborted (turn completed first)", async () => {
    const controller = new AbortController();
    controller.abort();
    let probed = false;
    await waitForSessionDown("s", controller.signal, {
      hasSession: async () => {
        probed = true;
        return true;
      },
      sleep: noSleep,
    });
    expect(probed).toBe(false); // never probed — already aborted
  });
});

describe("dispatcher busy→down (§5.1, §10.9)", () => {
  let root: string;
  let paths: QueuePaths;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "teamai-down-"));
    paths = queuePaths(root, "s");
    await ensureQueueDirs(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function msg(id: string): Message {
    return { id, from: "a", to: "b", kind: "message", ts: 0, payload: id };
  }

  function jsonFiles(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  }

  test("a session lost mid-turn → status down, cur/ kept for re-send (not failed)", async () => {
    await enqueue(paths, { unixMs: 1, seq: 1, fileId: "a", message: msg("a") });
    const state = new AgentState("idle");
    // a turn that never finishes (agent is hung/gone), and a probe that reports down:
    const driver: SessionDriver = {
      inject: async () => undefined,
      awaitTurn: () => new Promise<void>(() => undefined), // never returns idle
    };
    const dispatcher = new Dispatcher({
      paths,
      driver,
      render: (m) => String(m.payload),
      state,
      doneIds: new Set(),
      awaitDown: (signal) =>
        waitForSessionDown("s", signal, { hasSession: async () => false, sleep: noSleep }),
    });

    expect(await dispatcher.pump()).toBe(1);
    expect(state.status).toBe("down");
    expect(jsonFiles(paths.cur)).toHaveLength(1); // left in cur for re-send (§10.9)
    expect(jsonFiles(paths.failed)).toHaveLength(0); // NOT failed (busy→down ≠ render error)
    expect(jsonFiles(paths.done)).toHaveLength(0);
  });

  test("after restart, recover re-sends the cur/ message left by a down (§10.9)", async () => {
    // arrange: a message stuck in cur/ from a prior down
    await enqueue(paths, { unixMs: 1, seq: 1, fileId: "a", message: msg("a") });
    const downState = new AgentState("idle");
    await new Dispatcher({
      paths,
      driver: {
        inject: async () => undefined,
        awaitTurn: () => new Promise<void>(() => undefined),
      },
      render: (m) => String(m.payload),
      state: downState,
      doneIds: new Set(),
      awaitDown: (signal) =>
        waitForSessionDown("s", signal, { hasSession: async () => false, sleep: noSleep }),
    }).pump();
    expect(jsonFiles(paths.cur)).toHaveLength(1);

    // act: agent restarted (state idle again), a healthy dispatcher recovers
    const injected: string[] = [];
    await new Dispatcher({
      paths,
      driver: {
        inject: async (text) => {
          injected.push(text);
        },
        awaitTurn: async () => undefined,
      },
      render: (m) => String(m.payload),
      state: new AgentState("idle"),
      doneIds: new Set(),
    }).recover();

    expect(injected).toEqual(["a"]); // re-sent
    expect(jsonFiles(paths.done)).toHaveLength(1);
    expect(jsonFiles(paths.cur)).toHaveLength(0);
  });
});
