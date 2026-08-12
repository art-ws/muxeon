// Internal slash commands (T90, FR-67): system-side, read-only — /screenshot
// captures the visible console as-is at ANY live status (busy included — that
// is its purpose: inspecting a possibly-stuck turn) and never injects input.
// The registry is pinned to the reserved-name list in @muxeon/config (§7.5).

import { describe, expect, test } from "bun:test";
import { INTERNAL_COMMAND_SLASHES } from "@muxeon/config";
import { internalCommands } from "../src/internal";
import { fakeControl, makeTarget } from "./helpers";

const screenshot = internalCommands.get("screenshot");
if (screenshot === undefined) throw new Error("missing /screenshot");

describe("internal command registry (FR-67)", () => {
  test("implements exactly the reserved names — config validation and the registry cannot drift", () => {
    expect([...internalCommands.keys()].sort()).toEqual([...INTERNAL_COMMAND_SLASHES].sort());
  });
});

describe("/screenshot (FR-67)", () => {
  test("returns the visible pane verbatim and injects nothing", async () => {
    const { target } = makeTarget({ status: "idle" });
    const control = fakeControl({ panes: ["READY> some half-typed input"] });
    const output = await screenshot.run(target, { control });
    expect(output).toBe("READY> some half-typed input");
    expect(control.calls.captured).toEqual(["researcher-session"]);
    // read-only by contract: no literal, no keys, no session ops
    expect(control.calls.literal).toEqual([]);
    expect(control.calls.keys).toEqual([]);
    expect(control.calls.killed).toEqual([]);
  });

  test("works on a BUSY agent — the whole point is inspecting a stuck turn", async () => {
    const { target } = makeTarget({ status: "busy" });
    const control = fakeControl({ panes: ["✶ Thinking… (esc to interrupt)"] });
    await expect(screenshot.run(target, { control })).resolves.toBe(
      "✶ Thinking… (esc to interrupt)",
    );
  });

  test("a down agent has no console — refused", async () => {
    const { target } = makeTarget({ status: "down" });
    const control = fakeControl();
    await expect(screenshot.run(target, { control })).rejects.toThrow(/down — no console/);
    expect(control.calls.captured).toEqual([]);
  });
});
