import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PauseFile, PauseRegistry, seedPauseRegistry } from "../src/pause";
import { createFsPauseStore } from "../src/pause-state";

describe("PauseRegistry (§16.1/§16.4, FR-116)", () => {
  test("set(true) pauses, set(false) resumes; membership is queryable", () => {
    const registry = new PauseRegistry();
    expect(registry.has("dev")).toBe(false);
    expect(registry.set("dev", true)).toBe(true);
    expect(registry.has("dev")).toBe(true);
    expect(registry.set("dev", false)).toBe(true);
    expect(registry.has("dev")).toBe(false);
  });

  test("the mutation is IDEMPOTENT and reports whether it changed anything", () => {
    const registry = new PauseRegistry();
    expect(registry.set("dev", true)).toBe(true); // changed → the caller persists
    expect(registry.set("dev", true)).toBe(false); // no-op → no write
    expect(registry.set("dev", false)).toBe(true);
    expect(registry.set("dev", false)).toBe(false); // resuming a live agent is a no-op
  });

  test("list()/snapshot() are sorted — a stable file across writes", () => {
    const registry = new PauseRegistry(["zeta", "alpha"]);
    registry.set("mid", true);
    expect(registry.list()).toEqual(["alpha", "mid", "zeta"]);
    expect(registry.snapshot()).toEqual({ version: 1, paused: ["alpha", "mid", "zeta"] });
  });

  test("pausing is per-agent — one flag never implies another", () => {
    const registry = new PauseRegistry(["a"]);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(false);
  });
});

describe("seedPauseRegistry — rehydrate (§16.4, §10.20)", () => {
  const known = (name: string): boolean => name === "dev" || name === "writer";

  test("a persisted set comes back after a restart", () => {
    const { registry, dropped } = seedPauseRegistry({ version: 1, paused: ["dev"] }, known);
    expect(registry.has("dev")).toBe(true);
    expect(dropped).toEqual([]);
  });

  test("a name that is no longer a configured agent is DROPPED and reported (never silent)", () => {
    const { registry, dropped } = seedPauseRegistry(
      { version: 1, paused: ["dev", "ghost"] },
      known,
    );
    expect(registry.has("dev")).toBe(true);
    expect(registry.has("ghost")).toBe(false);
    expect(dropped).toEqual(["ghost"]);
  });

  test("a missing / corrupt file (null) starts empty — nothing paused is the safe side", () => {
    const { registry, dropped } = seedPauseRegistry(null, known);
    expect(registry.list()).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("junk entries in the file are ignored, not crashed on", () => {
    const junk = { version: 1, paused: ["dev", "", 7, null] } as unknown as PauseFile;
    const { registry } = seedPauseRegistry(junk, known);
    expect(registry.list()).toEqual(["dev"]);
  });
});

describe("createFsPauseStore — state/paused.json (§16.4)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "muxeon-pause-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("write → read round-trips the snapshot (and creates the dir)", async () => {
    const store = createFsPauseStore(join(stateDir, "state"));
    await store.write({ version: 1, paused: ["dev"] });
    expect(await store.read()).toEqual({ version: 1, paused: ["dev"] });
  });

  test("the write is atomic — no .tmp file is left behind", async () => {
    const store = createFsPauseStore(stateDir);
    await store.write({ version: 1, paused: ["dev"] });
    expect(readFileSync(join(stateDir, "paused.json"), "utf8")).toContain("dev");
    expect(() => readFileSync(join(stateDir, "paused.json.tmp"), "utf8")).toThrow();
  });

  test("a missing file reads as null (a fresh install has no state)", async () => {
    expect(await createFsPauseStore(join(stateDir, "nope")).read()).toBeNull();
  });

  test("a corrupt / half-written file reads as null, not a throw", async () => {
    writeFileSync(join(stateDir, "paused.json"), '{"version":1,"paused":["de');
    expect(await createFsPauseStore(stateDir).read()).toBeNull();
  });
});
