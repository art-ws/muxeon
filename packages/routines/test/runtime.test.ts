import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortableSleep, createFsStateStore, startScheduler } from "../src/index";
import { recRouter } from "./helpers";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-runtime-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("startScheduler loop (§6)", () => {
  test("discovers a once routine and fires it on the first tick, then stops", async () => {
    const routinesDir = join(root, "routines");
    mkdirSync(join(routinesDir, "researcher"), { recursive: true });
    writeFileSync(
      join(routinesDir, "researcher", "kick.md"),
      "---\nid: kick\nschedule: once\n---\nwake up",
    );
    const router = recRouter();
    const state = createFsStateStore(join(root, "state"));

    let resolveTicked: () => void = () => undefined;
    const ticked = new Promise<void>((resolve) => {
      resolveTicked = resolve;
    });
    const handle = startScheduler({
      router,
      state,
      routinesDir,
      knownAgents: ["researcher"],
      tickIntervalMs: 1,
      rescanIntervalMs: 999_999,
      sleep: async () => {
        resolveTicked(); // first sleep ⇒ at least one tick has run
        await new Promise((r) => setTimeout(r, 1));
      },
    });

    await ticked;
    await handle.stop();

    // once is idempotent, so however many times the loop spun, it sent exactly one.
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]).toMatchObject({
      from: "researcher",
      to: "researcher",
      payload: "wake up",
    });
  });
});

describe("abortableSleep (T348)", () => {
  test("a sleep the timer ends detaches its abort listener — ticks leave nothing on the signal", async () => {
    const controller = new AbortController();
    const { signal } = controller;
    let attached = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
      attached += 1;
      add(type, listener, options as AddEventListenerOptions);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListener, options?: unknown) => {
      attached -= 1;
      remove(type, listener, options as EventListenerOptions);
    }) as typeof signal.removeEventListener;
    for (let i = 0; i < 50; i++) await abortableSleep(0, signal);
    expect(attached).toBe(0); // the scheduler's signal fires only at stop()
  });

  test("abort cuts a long sleep short, and an aborted signal does not sleep at all", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await pending;
    await abortableSleep(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
