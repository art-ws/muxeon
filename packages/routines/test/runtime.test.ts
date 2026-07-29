import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStateStore, startScheduler } from "../src/index";
import { recRouter } from "./helpers";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "teamai-runtime-"));
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
