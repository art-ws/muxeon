import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStateStore, rescan, tick } from "../src/index";
import { ms, recRouter } from "./helpers";

let root: string;
let routinesDir: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-rescan-"));
  routinesDir = join(root, "routines");
  stateDir = join(root, "state");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRoutine(owner: string, name: string, body: string): void {
  const dir = join(routinesDir, owner);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

describe("rescan (§6, FR-23)", () => {
  test("the enabled:false kill-switch takes effect on the next re-scan + tick", async () => {
    const state = createFsStateStore(stateDir);
    const router = recRouter();
    writeRoutine("researcher", "r.md", "---\nid: r\nschedule: 0 9 * * *\n---\nping");

    const before = await rescan({ routinesDir, knownAgents: ["researcher"], state });
    expect(before.routines[0]?.enabled).toBe(true);

    // operator disables it
    writeRoutine(
      "researcher",
      "r.md",
      "---\nid: r\nschedule: 0 9 * * *\nenabled: false\n---\nping",
    );
    const after = await rescan({ routinesDir, knownAgents: ["researcher"], state });
    expect(after.routines[0]?.enabled).toBe(false);

    // even with a tick due, the refreshed (disabled) routine does not fire (FR-23)
    await state.write("researcher", "r", { lastRun: ms("2026-03-01T09:00:00Z") });
    const results = await tick(after.routines, {
      router,
      state,
      now: () => ms("2026-03-02T10:00:00Z"),
    });
    expect(results[0]?.outcome).toBe("disabled");
    expect(router.sent).toHaveLength(0);
  });

  test("a hot-added once routine appears on re-scan", async () => {
    const state = createFsStateStore(stateDir);
    expect(
      (await rescan({ routinesDir, knownAgents: ["researcher"], state })).routines,
    ).toHaveLength(0);
    writeRoutine("researcher", "kick.md", "---\nid: kick\nschedule: once\n---\nwake");
    const after = await rescan({ routinesDir, knownAgents: ["researcher"], state });
    expect(after.routines.map((r) => r.id)).toEqual(["kick"]);
  });

  test("orphan state (no matching routine) is pruned on re-scan (§6.3)", async () => {
    const state = createFsStateStore(stateDir);
    writeRoutine("researcher", "live.md", "---\nid: live\nschedule: once\n---\nx");
    await state.write("researcher", "live", { done: true, doneAt: 1 });
    await state.write("researcher", "removed", { done: true, doneAt: 1 }); // file no longer exists

    const result = await rescan({ routinesDir, knownAgents: ["researcher"], state });
    expect(result.pruned).toEqual([{ owner: "researcher", id: "removed" }]);
    expect(await state.read("researcher", "removed")).toBeNull(); // gone
    expect(await state.read("researcher", "live")).not.toBeNull(); // kept
  });
});
