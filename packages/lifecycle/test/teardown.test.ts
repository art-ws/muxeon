// Graceful teardown (T85, FR-64, §5.1): slash/keys ask → grace window → hard
// kill; no strategy = plain kill; the agent ends down in every path.

import { describe, expect, test } from "bun:test";
import { TEARDOWN_DEFAULT_GRACE_MS, teardown } from "../src/teardown";
import { fakeControl, makeTarget } from "./helpers";

const noSleep = async (): Promise<void> => undefined;

describe("teardown (FR-64)", () => {
  test("no strategy → straight hard kill", async () => {
    const control = fakeControl({ present: ["rs"] });
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    expect(await teardown(kit.target, { control })).toBe("down");
    expect(control.calls.killed).toEqual(["rs"]);
    expect(control.calls.literal).toEqual([]); // nothing graceful was attempted
  });

  test("slash ask: rendered by the adapter, settled Enter, session dies in grace → NO kill", async () => {
    const control = fakeControl({ present: ["rs"] });
    let polls = 0;
    const originalHas = control.hasSession;
    control.hasSession = async (name) => {
      polls += 1;
      if (polls >= 3) return false; // the agent exits by itself on the 3rd look
      return originalHas(name);
    };
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    const status = await teardown(kit.target, {
      control,
      strategy: { slash: "exit", graceMs: 10_000 },
      sleep: noSleep,
    });
    expect(status).toBe("down");
    expect(control.calls.literal).toEqual([{ name: "rs", text: "/exit" }]);
    expect(control.calls.keys).toEqual([{ name: "rs", keys: ["Enter"] }]);
    expect(control.calls.killed).toEqual([]); // died gracefully
  });

  test("grace expires → hard kill settles it", async () => {
    const control = fakeControl({ present: ["rs"] });
    let clock = 0;
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    const status = await teardown(kit.target, {
      control,
      strategy: { slash: "exit", graceMs: 1000 },
      sleep: async () => {
        clock += 500;
      },
      now: () => clock,
    });
    expect(status).toBe("down");
    expect(control.calls.killed).toEqual(["rs"]); // the fallback fired
  });

  test("keys-only strategy sends the raw keys", async () => {
    const control = fakeControl({ present: ["rs"] });
    let clock = 0;
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    await teardown(kit.target, {
      control,
      strategy: { keys: ["C-c", "C-d"], graceMs: 100 },
      sleep: async () => {
        clock += 500;
      },
      now: () => clock,
    });
    expect(control.calls.literal).toEqual([]); // no slash
    expect(control.calls.keys).toEqual([{ name: "rs", keys: ["C-c", "C-d"] }]);
  });

  test("an already-gone session just confirms down — no input, no kill", async () => {
    const control = fakeControl({ present: [] });
    const kit = makeTarget({ tmux: "rs", status: "down" });
    expect(
      await teardown(kit.target, { control, strategy: { slash: "exit" }, sleep: noSleep }),
    ).toBe("down");
    expect(control.calls.literal).toEqual([]);
    expect(control.calls.keys).toEqual([]);
    expect(control.calls.killed).toEqual([]);
  });

  test("a session refusing input still goes through grace to the hard kill", async () => {
    const control = fakeControl({ present: ["rs"] });
    control.sendLiteral = async () => {
      throw new Error("session is wedged");
    };
    let clock = 0;
    const kit = makeTarget({ tmux: "rs", status: "busy" });
    const status = await teardown(kit.target, {
      control,
      strategy: { slash: "exit", graceMs: 100 },
      sleep: async () => {
        clock += 500;
      },
      now: () => clock,
    });
    expect(status).toBe("down");
    expect(control.calls.killed).toEqual(["rs"]);
  });

  test("an idle-only strategy (no slash/keys, FR-92) is a straight hard kill", async () => {
    const control = fakeControl({ present: ["rs"] });
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    // teardown.idle carries the auto-teardown window but no graceful ask — the
    // resolved strategy is { idle } with no slash/keys, so teardown hard-kills.
    expect(await teardown(kit.target, { control, strategy: { idle: "1h" } })).toBe("down");
    expect(control.calls.killed).toEqual(["rs"]);
    expect(control.calls.literal).toEqual([]); // nothing graceful attempted
  });

  test("the default grace window is 5s", () => {
    expect(TEARDOWN_DEFAULT_GRACE_MS).toBe(5000);
  });
});
