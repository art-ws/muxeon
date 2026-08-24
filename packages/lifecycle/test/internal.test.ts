// Internal slash commands (T90, FR-67): system-side — /screenshot captures the
// visible console as-is at ANY live status (busy included — that is its purpose:
// inspecting a possibly-stuck turn), /pause and /unpause (§16.5, FR-198) move the
// transport flag. What they share is not "read-only" but "never types into the
// console", which is what makes them laneless and idle-free.
// The registry is pinned to the reserved-name list in @muxeon/config (§7.5).

import { describe, expect, test } from "bun:test";
import { INTERNAL_COMMAND_SLASHES } from "@muxeon/config";
import { type PausePort, internalCommands, isInternalCommand } from "../src/internal";
import { fakeControl, makeTarget } from "./helpers";

const screenshot = internalCommands.get("screenshot");
if (screenshot === undefined) throw new Error("missing /screenshot");
const pause = internalCommands.get("pause");
const unpause = internalCommands.get("unpause");
if (pause === undefined || unpause === undefined) throw new Error("missing /pause or /unpause");

/** The pause registry as the admin wires it: a set plus a persist counter. */
function fakePause(initial: string[] = []) {
  const paused = new Set(initial);
  const calls = { persisted: 0 };
  const port: PausePort = {
    has: (name) => paused.has(name),
    set: (name, next) => {
      const had = paused.has(name);
      if (next) paused.add(name);
      else paused.delete(name);
      return had !== next;
    },
    persist: async () => {
      calls.persisted += 1;
    },
  };
  return { port, paused, calls };
}

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

// /pause and /unpause (§16.5, FR-198): the agent-facing half of the pause the
// operator has had since §16. They move the SAME registry the router reads, work
// in any status (that is the point — an agent wraps its own sequence mid-turn),
// and type nothing into the console.
describe("/pause and /unpause (§16.5, FR-198)", () => {
  test("pause sets the flag and persists the change; unpause clears it", async () => {
    const { target } = makeTarget({ status: "busy" });
    const control = fakeControl();
    const { port, paused, calls } = fakePause();

    const on = await pause.run(target, { control, pause: port });
    expect(paused.has("researcher")).toBe(true);
    expect(on).toContain("paused");
    expect(calls.persisted).toBe(1);

    const off = await unpause.run(target, { control, pause: port });
    expect(paused.has("researcher")).toBe(false);
    expect(off).toContain("unpaused");
    expect(calls.persisted).toBe(2);
    // nothing was typed, captured or killed — the console was never touched
    expect(control.calls.literal).toEqual([]);
    expect(control.calls.keys).toEqual([]);
    expect(control.calls.captured).toEqual([]);
  });

  test("idempotent: a repeat says so and does NOT re-persist (§16.4)", async () => {
    const { target } = makeTarget({ status: "idle" });
    const control = fakeControl();
    const { port, calls } = fakePause(["researcher"]);
    const again = await pause.run(target, { control, pause: port });
    expect(again).toContain("already paused");
    expect(calls.persisted).toBe(0); // nothing changed ⇒ nothing to mirror
    const notPaused = await unpause.run(target, { control, pause: port });
    expect(notPaused).toContain("unpaused"); // it WAS paused, so this one changes it
    expect(calls.persisted).toBe(1);
    const spurious = await unpause.run(target, { control, pause: port });
    expect(spurious).toContain("was not paused");
    expect(calls.persisted).toBe(1);
  });

  test("a DOWN agent can still be paused — the flag is transport, not a session op (§16.1)", async () => {
    const { target } = makeTarget({ status: "down" });
    const { port, paused } = fakePause();
    await pause.run(target, { control: fakeControl(), pause: port });
    expect(paused.has("researcher")).toBe(true);
  });

  test("a failed mirror does not fail the command — the flag is already in effect", async () => {
    const { target } = makeTarget({ status: "idle" });
    const { port, paused } = fakePause();
    const brittle: PausePort = {
      ...port,
      persist: async () => {
        throw new Error("disk full");
      },
    };
    await expect(pause.run(target, { control: fakeControl(), pause: brittle })).resolves.toContain(
      "paused",
    );
    expect(paused.has("researcher")).toBe(true);
  });

  test("without a wired registry it SAYS so instead of silently doing nothing", async () => {
    const { target } = makeTarget({ status: "idle" });
    await expect(pause.run(target, { control: fakeControl() })).rejects.toThrow(/not wired/);
  });

  test("isInternalCommand names exactly the laneless set", () => {
    expect(isInternalCommand("pause")).toBe(true);
    expect(isInternalCommand("unpause")).toBe(true);
    expect(isInternalCommand("screenshot")).toBe(true);
    expect(isInternalCommand("clear")).toBe(false);
    expect(isInternalCommand("")).toBe(false);
  });
});
