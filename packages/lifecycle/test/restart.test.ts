import { describe, expect, test } from "bun:test";
import { restart } from "../src/restart";
import { fakeControl, makeTarget } from "./helpers";

describe("restart (§4, FR-9, §5.1)", () => {
  test("kills then provisions, ending idle (kill before new-session)", async () => {
    const control = fakeControl({ present: ["rs"] });
    const kit = makeTarget({ tmux: "rs", status: "idle", provision: { command: ["claude"] } });

    const status = await restart(kit.target, { control, configDir: "/cfg" });

    expect(control.calls.killed).toEqual(["rs"]); // killed first
    expect(control.calls.newSession.map((c) => c.name)).toEqual(["rs"]); // then re-provisioned
    expect(control.calls.newSession[0]?.options.command).toEqual(["claude"]); // argv (§8.7)
    expect(status).toBe("idle");
    expect(kit.target.state.status).toBe("idle"); // down → idle; the dispatcher loop drains (§10.9)
  });

  test("restarting a down agent still comes up idle", async () => {
    const control = fakeControl({ present: [] }); // already gone
    const kit = makeTarget({ tmux: "rs", status: "down", provision: { command: ["claude"] } });
    expect(await restart(kit.target, { control, configDir: "/cfg" })).toBe("idle");
  });
});
