import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRender } from "@muxeon/adapters";
import type { Message } from "@muxeon/core";
import {
  type QueuePaths,
  dequeue,
  enqueue,
  ensureQueueDirs,
  queuePaths,
  sanitizeFileId,
} from "@muxeon/queue";
import { Dispatcher, type SessionDriver } from "../src/dispatcher";
import { AgentState } from "../src/status";

let root: string;
let paths: QueuePaths;
let seq: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-dispatcher-"));
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
  await enqueue(paths, {
    unixMs: 1700000000000,
    seq,
    fileId: sanitizeFileId(id),
    message: msg(id),
  });
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function take<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value");
  return value;
}

const okDriver = (injected: string[] = []): SessionDriver => ({
  inject: async (text) => {
    injected.push(text);
  },
  awaitTurn: async () => undefined,
});

function makeDispatcher(
  driver: SessionDriver,
  state = new AgentState("idle"),
  doneIds = new Set<string>(),
): Dispatcher {
  return new Dispatcher({ paths, driver, render: defaultRender, state, doneIds });
}

describe("dispatcher loop (§8.2, §10.1/§10.8/§10.9, FR-13/35b)", () => {
  test("pump injects pending in FIFO order and completes them to done/", async () => {
    const injected: string[] = [];
    await put("a");
    await put("b");
    await put("c");
    expect(await makeDispatcher(okDriver(injected)).pump()).toBe(3);
    expect(jsonFiles(paths.done)).toHaveLength(3);
    expect(jsonFiles(paths.pending)).toHaveLength(0);
    expect(injected[0]).toContain("id=a");
    expect(injected[2]).toContain("id=c");
  });

  test("at most one message is in cur during a turn (|cur| ≤ 1, §10.1/§10.8)", async () => {
    const curCounts: number[] = [];
    const driver: SessionDriver = {
      inject: async () => undefined,
      awaitTurn: async () => {
        curCounts.push(jsonFiles(paths.cur).length);
      },
    };
    await put("a");
    await put("b");
    await makeDispatcher(driver).pump();
    expect(curCounts).toEqual([1, 1]); // each turn saw exactly one in cur
  });

  test("recover re-sends an in-flight cur file after a crash (§10.9)", async () => {
    await put("a");
    take(await dequeue(paths)); // claimed into cur/, then "crash" before complete
    const injected: string[] = [];
    await makeDispatcher(okDriver(injected)).recover();
    expect(injected[0]).toContain("id=a"); // re-injected in place
    expect(jsonFiles(paths.done)).toHaveLength(1);
    expect(jsonFiles(paths.cur)).toHaveLength(0);
  });

  test("a render error completes to failed/, not done/ (FR-35b)", async () => {
    await put("a");
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(),
      render: () => {
        throw new Error("render boom");
      },
      state: new AgentState("idle"),
      doneIds: new Set(),
    });
    await dispatcher.pump();
    expect(jsonFiles(paths.failed)).toHaveLength(1);
    expect(jsonFiles(paths.done)).toHaveLength(0);
  });

  test("an inject error completes to failed/ (FR-35b)", async () => {
    await put("a");
    const driver: SessionDriver = {
      inject: async () => {
        throw new Error("inject boom");
      },
      awaitTurn: async () => undefined,
    };
    await makeDispatcher(driver).pump();
    expect(jsonFiles(paths.failed)).toHaveLength(1);
  });

  test("a re-enqueued done id is skipped on the next pump (§10.9)", async () => {
    const doneIds = new Set<string>();
    const dispatcher = makeDispatcher(okDriver(), new AgentState("idle"), doneIds);
    await put("dup");
    await dispatcher.pump();
    expect(doneIds.has("dup")).toBe(true);
    await put("dup"); // producer re-enqueues the same logical id
    expect(await dispatcher.pump()).toBe(0); // skipped
    expect(jsonFiles(paths.pending)).toHaveLength(0); // dropped
  });

  test("a down session is not pumped (the queue accumulates)", async () => {
    await put("a");
    const driver: SessionDriver = {
      inject: async () => {
        throw new Error("a down session must not be injected");
      },
      awaitTurn: async () => undefined,
    };
    expect(await makeDispatcher(driver, new AgentState("down")).pump()).toBe(0);
    expect(jsonFiles(paths.pending)).toHaveLength(1); // still queued for when it comes up
  });

  // T145: a turn-racer that REJECTS — a session lost mid-turn slipping past the
  // driver's capture guard — must not escape processOne. The dispatcher loop is
  // fire-and-forget (bootstrap pushes run() into `runs`, awaited only at stop), so a
  // propagated reject becomes an unhandled rejection and Bun kills the whole server
  // (live finding: killing a busy agent crashed the stand). It drops to down instead.
  test("a rejecting turn-racer drops to down instead of crashing the loop (T145, §10.9)", async () => {
    await put("a");
    const state = new AgentState("idle");
    const dispatcher = new Dispatcher({
      paths,
      driver: {
        inject: async () => undefined,
        awaitTurn: async () => {
          throw new Error("tmux capture-pane failed: can't find session: s"); // killed mid-turn
        },
      },
      render: defaultRender,
      state,
      doneIds: new Set<string>(),
      awaitDown: async () => undefined, // the down-probe detects the loss
    });

    // Must not reject: the turn resolves to down, the message stays in cur/ for re-send.
    await dispatcher.pump();

    expect(state.status).toBe("down");
    expect(jsonFiles(paths.cur)).toHaveLength(1); // cur/ preserved (§10.9) — not failed
    expect(jsonFiles(paths.failed)).toHaveLength(0);
    expect(jsonFiles(paths.pending)).toHaveLength(0);
  });

  test("run() re-sends the in-flight cur/ and drains pending after a restart (§10.9)", async () => {
    // arrange: a turn left in cur/ by a prior down, plus a message that piled up while down.
    await put("a");
    take(await dequeue(paths)); // a claimed into cur/, never completed (the down)
    await put("b"); // accumulated in pending/ while the agent was down
    expect(jsonFiles(paths.cur)).toHaveLength(1);

    const injected: string[] = [];
    const state = new AgentState("down");
    const controller = new AbortController();
    let ticks = 0;
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(injected),
      render: defaultRender,
      state,
      doneIds: new Set(),
      sleep: async () => {
        ticks += 1;
        if (ticks === 1) state.to("idle"); // operator restart brings the session back up
        if (ticks >= 2) controller.abort(); // then let the loop converge and stop
      },
    });

    await dispatcher.run(controller.signal);

    expect(injected.map((t) => t.match(/id=(\w+)/)?.[1])).toEqual(["a", "b"]); // a re-sent, then b
    expect(jsonFiles(paths.done)).toHaveLength(2);
    expect(jsonFiles(paths.cur)).toHaveLength(0);
    expect(jsonFiles(paths.pending)).toHaveLength(0);
  });

  test("run() calls reviveDown when down WITH work, and the same iteration drains it (FR-51)", async () => {
    await put("a"); // work piled up while down
    const injected: string[] = [];
    const state = new AgentState("down");
    const controller = new AbortController();
    let revives = 0;
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(injected),
      render: defaultRender,
      state,
      doneIds: new Set(),
      reviveDown: async () => {
        revives += 1;
        state.to("idle"); // the reviver brought the session up (§5.1)
      },
      sleep: async () => controller.abort(), // first empty tick ends the loop
    });
    await dispatcher.run(controller.signal);
    expect(revives).toBe(1);
    expect(injected[0]).toContain("id=a"); // drained in the SAME iteration, no extra tick
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });

  test("run() does NOT revive a down session with an empty queue (FR-51)", async () => {
    const state = new AgentState("down");
    const controller = new AbortController();
    let revives = 0;
    let ticks = 0;
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(),
      render: defaultRender,
      state,
      doneIds: new Set(),
      reviveDown: async () => {
        revives += 1;
      },
      sleep: async () => {
        ticks += 1;
        if (ticks >= 2) controller.abort();
      },
    });
    await dispatcher.run(controller.signal);
    expect(revives).toBe(0); // no work — the queue accumulates silently (NFR-4)
  });

  test("exchange port: materialize before inject (render sees the path), cleanup after done/failed (FR-52)", async () => {
    const calls: string[] = [];
    const exchange = {
      materialize: async (message: Message) => {
        calls.push(`mat:${message.id}`);
        return { messageFile: `/x/inbox/${message.id}/message.json` };
      },
      cleanup: async (message: Message) => {
        calls.push(`clean:${message.id}`);
      },
    };
    const seenCtx: (string | undefined)[] = [];
    await put("a");
    const ok = new Dispatcher({
      paths,
      driver: okDriver(),
      render: (message, ctx) => {
        seenCtx.push(ctx?.messageFile);
        return String(message.payload);
      },
      state: new AgentState("idle"),
      doneIds: new Set(),
      exchange,
    });
    await ok.pump();
    expect(seenCtx).toEqual(["/x/inbox/a/message.json"]);
    expect(calls).toEqual(["mat:a", "clean:a"]); // materialized, then cleaned after done

    await put("b");
    const failing = new Dispatcher({
      paths,
      driver: {
        inject: async () => {
          throw new Error("inject boom");
        },
        awaitTurn: async () => undefined,
      },
      render: defaultRender,
      state: new AgentState("idle"),
      doneIds: new Set(),
      exchange,
    });
    await failing.pump();
    expect(calls).toEqual(["mat:a", "clean:a", "mat:b", "clean:b"]); // failed turn cleans too
  });

  test("file-detect completes a turn the output detector never would (FR-53)", async () => {
    await put("a");
    let releaseFile: () => void = () => undefined;
    const fileGone = new Promise<void>((resolve) => {
      releaseFile = resolve;
    });
    const dispatcher = new Dispatcher({
      paths,
      driver: {
        inject: async () => releaseFile(), // "agent" deletes the file right after inject
        awaitTurn: () => new Promise(() => undefined), // output detection never fires
      },
      render: defaultRender,
      state: new AgentState("idle"),
      doneIds: new Set(),
      exchange: {
        materialize: async (message) => ({ messageFile: `/x/${message.id}/message.json` }),
        awaitDone: async (_message, signal) => {
          await fileGone;
          if (signal.aborted) await new Promise(() => undefined);
        },
        cleanup: async () => undefined,
      },
    });
    expect(await dispatcher.pump()).toBe(1); // completed via file-detect alone
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });

  test("file-detect is NOT raced when materialization failed (no false instant done, FR-53)", async () => {
    await put("a");
    let awaitDoneCalled = false;
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(), // output detection completes the turn
      render: defaultRender,
      state: new AgentState("idle"),
      doneIds: new Set(),
      exchange: {
        materialize: async () => {
          throw new Error("disk full");
        },
        awaitDone: async () => {
          awaitDoneCalled = true; // would resolve instantly — the file never existed
        },
        cleanup: async () => undefined,
      },
    });
    await dispatcher.pump();
    expect(awaitDoneCalled).toBe(false); // guarded out of the race
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });

  test("a materialize failure degrades the render (no ctx), never fails the message (FR-52)", async () => {
    await put("a");
    const seenCtx: (string | undefined)[] = [];
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(),
      render: (message, ctx) => {
        seenCtx.push(ctx?.messageFile);
        return String(message.payload);
      },
      state: new AgentState("idle"),
      doneIds: new Set(),
      exchange: {
        materialize: async () => {
          throw new Error("disk full");
        },
        cleanup: async () => undefined,
      },
    });
    await dispatcher.pump();
    expect(seenCtx).toEqual([undefined]); // degraded, but delivered
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });

  test("materialize → null skips the inbox projection and file-detect (raw mode, FR-88)", async () => {
    await put("a");
    const seenCtx: (string | undefined)[] = [];
    let awaitDoneCalled = false;
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(), // output detection completes the turn
      render: (message, ctx) => {
        seenCtx.push(ctx?.messageFile);
        return String(message.payload);
      },
      state: new AgentState("idle"),
      doneIds: new Set(),
      exchange: {
        materialize: async () => null, // no projection this turn (a raw turn)
        awaitDone: async () => {
          awaitDoneCalled = true; // would be an instant false done with no file
        },
        cleanup: async () => undefined,
      },
    });
    await dispatcher.pump();
    expect(seenCtx).toEqual([undefined]); // render saw no message file → verbatim path
    expect(awaitDoneCalled).toBe(false); // file-detect guarded out (no message.json)
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });

  test("run() revives for an in-flight cur/ left by a crash (FR-51 + §10.9 recovery)", async () => {
    await put("a");
    take(await dequeue(paths)); // claimed into cur/, then the agent went down mid-turn
    const injected: string[] = [];
    const state = new AgentState("down");
    const controller = new AbortController();
    const dispatcher = new Dispatcher({
      paths,
      driver: okDriver(injected),
      render: defaultRender,
      state,
      doneIds: new Set(),
      reviveDown: async () => state.to("idle"),
      sleep: async () => controller.abort(),
    });
    await dispatcher.run(controller.signal);
    expect(injected[0]).toContain("id=a"); // cur/ re-sent right after the revive
    expect(jsonFiles(paths.cur)).toHaveLength(0);
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });
});

describe("turn-lifecycle hooks (§8.2, FR-45)", () => {
  function hookedDispatcher(
    driver: SessionDriver,
    calls: string[],
    opts: { failAfterTurn?: boolean; awaitDown?: (signal: AbortSignal) => Promise<void> } = {},
  ): Dispatcher {
    return new Dispatcher({
      paths,
      driver,
      render: defaultRender,
      state: new AgentState("idle"),
      doneIds: new Set(),
      ...(opts.awaitDown !== undefined ? { awaitDown: opts.awaitDown } : {}),
      beforeInject: (message) => calls.push(`before:${message.id}`),
      afterTurn: async (message) => {
        calls.push(`after:${message.id}`);
        if (opts.failAfterTurn === true) throw new Error("nudge route failed");
      },
    });
  }

  test("done turn: beforeInject before the injection, afterTurn after complete", async () => {
    const calls: string[] = [];
    const driver: SessionDriver = {
      inject: async () => {
        calls.push("inject");
      },
      awaitTurn: async () => undefined,
    };
    await put("m1");
    await hookedDispatcher(driver, calls).pump();
    expect(calls).toEqual(["before:m1", "inject", "after:m1"]);
    expect(jsonFiles(paths.done)).toHaveLength(1); // completed BEFORE the hook ran
  });

  test("failed injection: afterTurn does not run", async () => {
    const calls: string[] = [];
    const driver: SessionDriver = {
      inject: async () => {
        throw new Error("injection failed");
      },
      awaitTurn: async () => undefined,
    };
    await put("m1");
    await hookedDispatcher(driver, calls).pump();
    expect(calls).toEqual(["before:m1"]);
    expect(jsonFiles(paths.failed)).toHaveLength(1);
  });

  test("busy→down: afterTurn does not run, cur/ stays for re-send", async () => {
    const calls: string[] = [];
    const driver: SessionDriver = {
      inject: async () => undefined,
      awaitTurn: () => new Promise<void>(() => undefined), // never completes
    };
    const dispatcher = hookedDispatcher(driver, calls, {
      awaitDown: async () => undefined, // session confirmed gone immediately
    });
    await put("m1");
    await dispatcher.pump();
    expect(calls).toEqual(["before:m1"]);
    expect(jsonFiles(paths.cur)).toHaveLength(1); // re-sent on restart (§10.9)
  });

  test("a throwing afterTurn does not poison the turn or the loop", async () => {
    const calls: string[] = [];
    const driver: SessionDriver = {
      inject: async () => undefined,
      awaitTurn: async () => undefined,
    };
    await put("m1");
    await put("m2");
    const processed = await hookedDispatcher(driver, calls, { failAfterTurn: true }).pump();
    expect(processed).toBe(2); // both turns done despite the hook throwing
    expect(jsonFiles(paths.done)).toHaveLength(2);
    expect(calls).toEqual(["before:m1", "after:m1", "before:m2", "after:m2"]);
  });
});

describe("shutdown abort mid-turn (T66, §10.9)", () => {
  test("run() resolves while a turn is stuck; cur/ stays for the restart re-send", async () => {
    await put("stuck");
    const driver: SessionDriver = {
      inject: async () => undefined,
      awaitTurn: () => new Promise<void>(() => undefined), // never-idle detection (the T65 hang)
    };
    const dispatcher = makeDispatcher(driver);
    const controller = new AbortController();
    const run = dispatcher.run(controller.signal);
    // wait for the record to be claimed — the turn is in flight
    while (jsonFiles(paths.cur).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await run; // must resolve — shutdown never waits out a stuck turn
    expect(jsonFiles(paths.cur)).toHaveLength(1); // re-sent on restart (§10.9)
    expect(jsonFiles(paths.done)).toHaveLength(0); // never completed
  });

  test("an already-aborted signal refuses to start a turn", async () => {
    await put("late");
    const injected: string[] = [];
    const dispatcher = makeDispatcher(okDriver(injected));
    const controller = new AbortController();
    controller.abort();
    const item = take(await dequeue(paths, { skipIds: new Set<string>() }));
    expect(await dispatcher.processOne(item, controller.signal)).toBe("aborted");
    expect(injected).toHaveLength(0); // nothing reached the session
    expect(jsonFiles(paths.cur)).toHaveLength(1); // the claim stays for re-send
  });
});

describe("pause hold (§16.3, §10.20, FR-118)", () => {
  /** A dispatcher whose pause flag the test flips at will. */
  function pausable(
    driver: SessionDriver,
    paused: { value: boolean },
    extra: { reviveDown?: () => Promise<void> } = {},
  ): Dispatcher {
    return new Dispatcher({
      paths,
      driver,
      render: defaultRender,
      state: new AgentState("idle"),
      doneIds: new Set<string>(),
      isPaused: () => paused.value,
      ...(extra.reviveDown !== undefined ? { reviveDown: extra.reviveDown } : {}),
    });
  }

  test("while paused, pump injects nothing and the queue keeps its records", async () => {
    const injected: string[] = [];
    await put("a");
    await put("b");
    const dispatcher = pausable(okDriver(injected), { value: true });
    expect(await dispatcher.pump()).toBe(0);
    expect(injected).toHaveLength(0);
    expect(jsonFiles(paths.pending)).toHaveLength(2); // nothing claimed
    expect(jsonFiles(paths.cur)).toHaveLength(0);
  });

  test("the resume drains everything that piled up (§10.3/§10.9 — no loss)", async () => {
    const injected: string[] = [];
    await put("a");
    await put("b");
    const paused = { value: true };
    const dispatcher = pausable(okDriver(injected), paused);
    expect(await dispatcher.pump()).toBe(0);
    paused.value = false;
    expect(await dispatcher.pump()).toBe(2);
    expect(injected).toHaveLength(2);
    expect(jsonFiles(paths.done)).toHaveLength(2);
  });

  test("a pause set mid-drain stops the NEXT turn, never the running one (§10.1)", async () => {
    const injected: string[] = [];
    await put("a");
    await put("b");
    const paused = { value: false };
    // The driver pauses the agent DURING the first turn: the turn must still
    // complete normally, the second must not start.
    const driver: SessionDriver = {
      inject: async (text) => {
        injected.push(text);
        paused.value = true;
      },
      awaitTurn: async () => undefined,
    };
    const dispatcher = pausable(driver, paused);
    expect(await dispatcher.pump()).toBe(1);
    expect(injected).toHaveLength(1);
    expect(jsonFiles(paths.done)).toHaveLength(1); // the running turn finished
    expect(jsonFiles(paths.pending)).toHaveLength(1); // the next one waits
  });

  test("an in-flight cur/ is NOT re-sent while paused, and is re-sent after the resume", async () => {
    const injected: string[] = [];
    await put("crashed");
    take(await dequeue(paths, { skipIds: new Set<string>() })); // leave it in cur/
    const paused = { value: true };
    const dispatcher = pausable(okDriver(injected), paused);
    await dispatcher.recover();
    expect(injected).toHaveLength(0);
    expect(jsonFiles(paths.cur)).toHaveLength(1);
    paused.value = false;
    await dispatcher.recover();
    expect(injected).toHaveLength(1);
    expect(jsonFiles(paths.done)).toHaveLength(1);
  });

  test("the lazy auto-revive (FR-51) is suppressed while paused — nothing would be injected", async () => {
    await put("work");
    let revives = 0;
    const paused = { value: true };
    const dispatcher = pausable(okDriver(), paused, {
      reviveDown: async () => {
        revives += 1;
      },
    });
    await dispatcher.maybeRevive();
    expect(revives).toBe(0);
    paused.value = false;
    await dispatcher.maybeRevive();
    expect(revives).toBe(1); // work queued + unpaused ⇒ the normal one attempt
  });

  test("control ops keep draining while paused — commands/lifecycle stay available (§16.3)", async () => {
    await put("held");
    const paused = { value: true };
    const dispatcher = pausable(okDriver(), paused);
    let ran = false;
    const submitted = dispatcher.control.submit(async () => {
      ran = true;
    });
    await dispatcher.pump(); // pumps nothing, but drains the lane
    await submitted;
    expect(ran).toBe(true);
    expect(jsonFiles(paths.pending)).toHaveLength(1); // still held
  });
});
