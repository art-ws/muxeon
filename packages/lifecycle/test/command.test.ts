// Operator slash commands (T86, FR-66): adapter-rendered slash, settled Enter,
// pane captured AS-IS once stable, Escape only when configured; busy/down
// agents are refused.

import { describe, expect, test } from "bun:test";
import { captureConsole, runCommand } from "../src/command";
import { fakeControl, makeTarget } from "./helpers";

const noSleep = async (): Promise<void> => undefined;

describe("runCommand (FR-66)", () => {
  test("slash → settled Enter → stable pane returned verbatim", async () => {
    const control = fakeControl({
      present: ["rs"],
      panes: ["drawing…", "Usage: 42% of weekly limit", "Usage: 42% of weekly limit"],
    });
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    const output = await runCommand(kit.target, {
      control,
      command: { slash: "usage" },
      sleep: noSleep,
    });
    expect(output).toBe("Usage: 42% of weekly limit"); // as-is, once two looks agree
    expect(control.calls.literal).toEqual([{ name: "rs", text: "/usage" }]);
    expect(control.calls.keys).toEqual([{ name: "rs", keys: ["Enter"] }]); // no Escape
  });

  test('keys "capture Escape" sends Escape AFTER the capture (dialog commands)', async () => {
    const control = fakeControl({ present: ["rs"], panes: ["dialog", "dialog"] });
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    const output = await runCommand(kit.target, {
      control,
      command: { slash: "usage", keys: "capture Escape" },
      sleep: noSleep,
    });
    expect(output).toBe("dialog");
    expect(control.calls.keys).toEqual([
      { name: "rs", keys: ["Enter"] },
      { name: "rs", keys: ["Escape"] },
    ]);
  });

  test("a keys script (FR-80): pre-capture navigation, post-capture cleanup, delays slept", async () => {
    const control = fakeControl({ present: ["rs"], panes: ["model picked", "model picked"] });
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    const slept: number[] = [];
    const output = await runCommand(kit.target, {
      control,
      command: { slash: "model", keys: 'Down Down 300ms "opus" Enter capture Escape' },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(output).toBe("model picked");
    // navigation BEFORE the capture, Escape AFTER it — order preserved
    expect(control.calls.keys).toEqual([
      { name: "rs", keys: ["Enter"] }, // the slash submit
      { name: "rs", keys: ["Down"] },
      { name: "rs", keys: ["Down"] },
      { name: "rs", keys: ["Enter"] }, // the script's Enter
      { name: "rs", keys: ["Escape"] }, // post-capture
    ]);
    expect(control.calls.literal).toEqual([
      { name: "rs", text: "/model" },
      { name: "rs", text: "opus" }, // the quoted literal typed as-is
    ]);
    expect(slept).toContain(300); // the explicit delay was slept
  });

  test("a never-stabilizing pane returns at the cap (no infinite loop)", async () => {
    let n = 0;
    const control = fakeControl({ present: ["rs"] });
    control.capturePane = async () => `spinner frame ${n++}`;
    let clock = 0;
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    const output = await runCommand(kit.target, {
      control,
      command: { slash: "compact" },
      sleep: async () => {
        clock += 4000;
      },
      now: () => clock,
    });
    expect(output).toMatch(/^spinner frame \d+$/); // whatever was on screen at the cap
  });

  test.each([["busy"], ["down"]] as const)("a %s agent refuses the command", async (status) => {
    const control = fakeControl({ present: ["rs"] });
    const kit = makeTarget({ tmux: "rs", status });
    await expect(
      runCommand(kit.target, { control, command: { slash: "clear" }, sleep: noSleep }),
    ).rejects.toThrow(new RegExp(`is ${status}`));
    expect(control.calls.literal).toEqual([]); // nothing was typed
  });
});

describe("captureConsole (FR-88 — raw-mode capture)", () => {
  test("default rule: NO slash, just stabilize + capture the pane as-is", async () => {
    const control = fakeControl({
      present: ["rs"],
      panes: ["redrawing…", "❯ done", "❯ done"],
    });
    const kit = makeTarget({ tmux: "rs", status: "busy" }); // raw capture runs post-turn
    const output = await captureConsole(kit.target, { control, sleep: noSleep });
    expect(output).toBe("❯ done"); // as-is, once two looks agree
    expect(control.calls.literal).toEqual([]); // raw injects NOTHING (the dispatcher did)
    expect(control.calls.keys).toEqual([]); // and the default rule has no keystrokes
  });

  test("a raw.keys rule navigates before the capture and returns after it (FR-80)", async () => {
    const control = fakeControl({ present: ["rs"], panes: ["scrolled", "scrolled"] });
    const kit = makeTarget({ tmux: "rs", status: "busy" });
    const output = await captureConsole(kit.target, {
      control,
      raw: { keys: "C-b capture q" },
      sleep: noSleep,
    });
    expect(output).toBe("scrolled");
    expect(control.calls.keys).toEqual([
      { name: "rs", keys: ["C-b"] }, // BEFORE the capture — navigation
      { name: "rs", keys: ["q"] }, // AFTER the capture — back to the prompt
    ]);
  });
});
