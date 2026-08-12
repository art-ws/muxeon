import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RendezvousStore } from "../src/rendezvous";
import { createFsRendezvousStore } from "../src/rendezvous-state";

const T0 = 1_000_000;
const WINDOW = 15_000;

describe("RendezvousStore (§8.2, FR-105)", () => {
  test("register queues an intent and dedups one-per-pair", () => {
    const s = new RendezvousStore();
    expect(s.register("a", "b")).toBe(true);
    expect(s.register("a", "b")).toBe(false); // dedup
    expect(s.register("a", "c")).toBe(true);
    expect(s.intents("a").map((i) => i.to)).toEqual(["b", "c"]);
    expect(s.has("a", "b")).toBe(true);
    expect(s.has("a", "z")).toBe(false);
  });

  test("markNotified bumps attempts, arms the window, and won't re-notify the front", () => {
    const s = new RendezvousStore();
    s.register("a", "b");
    expect(s.markNotified("a", T0 + WINDOW)).toBe("b");
    const front = s.front("a");
    expect(front).toEqual({ to: "b", attempts: 1, phase: "notified", windowUntil: T0 + WINDOW });
    // already notified → no re-ping until the window resolves
    expect(s.markNotified("a", T0 + 2 * WINDOW)).toBeUndefined();
    expect(s.windowOpen("a", T0)).toBe(true);
    expect(s.windowOpen("a", T0 + WINDOW)).toBe(false);
    expect(s.windowExpired("a", T0 + WINDOW)).toBe(true);
  });

  test("resolve removes the pair wherever it sits (accepted B→A)", () => {
    const s = new RendezvousStore();
    s.register("a", "b");
    s.register("a", "c");
    s.markNotified("a", T0 + WINDOW); // b notified
    expect(s.resolve("a", "c")).toBe(true); // a non-front, still-waiting intent
    expect(s.intents("a").map((i) => i.to)).toEqual(["b"]);
    expect(s.resolve("a", "b")).toBe(true);
    expect(s.senders()).toEqual([]); // queue emptied → sender dropped
    expect(s.resolve("a", "b")).toBe(false); // gone
  });

  test("expireFront rotates before maxAttempts, drops at maxAttempts", () => {
    const s = new RendezvousStore();
    s.register("a", "b");
    s.register("a", "c");
    // round 1 for b: notify then expire → rotate to back (b behind c)
    s.markNotified("a", T0 + WINDOW);
    expect(s.expireFront("a", 3)).toEqual({ to: "b", outcome: "rotated" });
    expect(s.intents("a").map((i) => i.to)).toEqual(["c", "b"]);
    // drive b to maxAttempts=3: it already has 1 attempt; two more rounds
    const cycle = (): void => {
      // bring b to the front (rotate c away once), then notify+expire b
      s.markNotified("a", T0 + WINDOW); // notifies front (c) round
      s.expireFront("a", 3); // c rotates
    };
    cycle(); // c: attempt1 → rotated; front now b
    s.markNotified("a", T0 + WINDOW); // b attempt2
    expect(s.expireFront("a", 3)).toEqual({ to: "b", outcome: "rotated" });
    // c to front, rotate; then b attempt3 → dropped
    s.markNotified("a", T0 + WINDOW);
    s.expireFront("a", 3); // c
    s.markNotified("a", T0 + WINDOW); // b attempt3
    expect(s.front("a")?.attempts).toBe(3);
    expect(s.expireFront("a", 3)).toEqual({ to: "b", outcome: "dropped" });
    expect(s.has("a", "b")).toBe(false);
  });

  test("expireFront is a no-op unless the front is notified", () => {
    const s = new RendezvousStore();
    s.register("a", "b");
    expect(s.expireFront("a", 3)).toBeUndefined(); // front is 'waiting'
    expect(s.expireFront("nobody", 3)).toBeUndefined();
  });

  test("dirty flag tracks unpersisted mutations", () => {
    const s = new RendezvousStore();
    expect(s.isDirty("a")).toBe(false);
    s.register("a", "b");
    expect(s.isDirty("a")).toBe(true);
    s.clearDirty("a");
    expect(s.isDirty("a")).toBe(false);
    s.markNotified("a", T0 + WINDOW); // attempts changed → dirty again
    expect(s.isDirty("a")).toBe(true);
  });

  test("snapshot → seed round-trips durable fields; seed resets phase to waiting", () => {
    const s = new RendezvousStore();
    s.register("a", "b");
    s.register("a", "c");
    s.markNotified("a", T0 + WINDOW); // b: attempts 1, notified (runtime-only)
    const restored = new RendezvousStore();
    restored.seed("a", s.snapshot("a"));
    expect(restored.intents("a")).toEqual([
      { to: "b", attempts: 1, phase: "waiting", windowUntil: 0 },
      { to: "c", attempts: 0, phase: "waiting", windowUntil: 0 },
    ]);
  });

  test("seed defends against dupes / bad attempts and ignores an empty file", () => {
    const s = new RendezvousStore();
    s.seed("a", {
      version: 1,
      intents: [
        ["b", 2],
        ["b", 9], // dup pair → dropped
        ["c", -1], // bad attempts → clamped to 0
        ["", 1], // empty target → dropped
      ],
    });
    expect(s.intents("a")).toEqual([
      { to: "b", attempts: 2, phase: "waiting", windowUntil: 0 },
      { to: "c", attempts: 0, phase: "waiting", windowUntil: 0 },
    ]);
    s.seed("x", undefined);
    expect(s.has("x", "y")).toBe(false);
  });
});

describe("createFsRendezvousStore (§8.2, FR-105)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muxeon-rz-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("write → read round-trips; missing reads null", async () => {
    const fs = createFsRendezvousStore(dir);
    expect(await fs.read("agent/one")).toBeNull(); // encodes the slash, no dir escape
    await fs.write("agent/one", { version: 1, intents: [["b", 1]] });
    expect(await fs.read("agent/one")).toEqual({ version: 1, intents: [["b", 1]] });
  });

  test("list enumerates senders; remove deletes the file", async () => {
    const fs = createFsRendezvousStore(dir);
    await fs.write("a", { version: 1, intents: [["b", 0]] });
    await fs.write("c", { version: 1, intents: [["d", 0]] });
    expect([...(await fs.list())].sort()).toEqual(["a", "c"]);
    await fs.remove("a");
    expect(await fs.list()).toEqual(["c"]);
    await fs.remove("a"); // idempotent
  });

  test("write is atomic — no .tmp lingers after commit", async () => {
    const fs = createFsRendezvousStore(dir);
    await fs.write("a", { version: 1, intents: [["b", 0]] });
    const files = await readdir(join(dir, "rendezvous"));
    expect(files).toEqual(["a.json"]);
  });
});
