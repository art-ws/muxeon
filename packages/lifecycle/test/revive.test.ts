// Reviver (FR-50/FR-51, §5.1): one auto attempt per down-episode, with a stop —
// the budget is spent by the attempt and restored only by a done/ turn (noteDone)
// or an operator lifecycle op (reset).

import { describe, expect, test } from "bun:test";
import { createReviver } from "../src/revive";
import { fakeControl, makeTarget } from "./helpers";

const PROVISION = { command: "claude" } as const;

describe("reviver (FR-50/FR-51, §5.1)", () => {
  test("revives a down agent by provisioning a missing session", async () => {
    const { target } = makeTarget({ provision: PROVISION });
    const control = fakeControl();
    const reviver = createReviver(target, { control, configDir: "/cfg" });
    expect(await reviver.revive()).toBe(true);
    expect(target.state.status).toBe("idle");
    expect(target.state.origin).toBe("system"); // provisioned → ours (§5.1, FR-92)
    expect(control.calls.newSession).toHaveLength(1);
    expect(control.calls.newSession[0]?.options.cwd).toBe("/cfg");
  });

  test("a live session attaches instead of provisioning (manual start)", async () => {
    const { target } = makeTarget({ provision: PROVISION });
    const control = fakeControl({ present: [target.agent.tmux] });
    const reviver = createReviver(target, { control, configDir: "/cfg" });
    expect(await reviver.revive()).toBe(true);
    expect(target.state.status).toBe("idle");
    expect(target.state.origin).toBe("external"); // attached, not raised by us (§5.1, FR-92)
    expect(control.calls.newSession).toHaveLength(0); // no double-provision
  });

  test("the budget stops a second attempt until noteDone (poison stop, OOS-10)", async () => {
    const { target } = makeTarget({ provision: PROVISION });
    const control = fakeControl();
    const reviver = createReviver(target, { control, configDir: "/cfg" });
    expect(await reviver.revive()).toBe(true);
    await control.killSession(target.agent.tmux); // crashed again…
    target.state.to("down"); // …no done/ turn in between
    expect(await reviver.revive()).toBe(false); // stop: no autonomous restart loop
    expect(control.calls.newSession).toHaveLength(1);
    reviver.noteDone(); // proof of progress restores the budget
    expect(await reviver.revive()).toBe(true);
    expect(control.calls.newSession).toHaveLength(2);
  });

  test("an operator lifecycle op (reset) also restores the budget", async () => {
    const { target } = makeTarget({ provision: PROVISION });
    const control = fakeControl();
    const reviver = createReviver(target, { control, configDir: "/cfg" });
    await reviver.revive();
    target.state.to("down");
    expect(await reviver.revive()).toBe(false);
    reviver.reset();
    expect(await reviver.revive()).toBe(true);
  });

  test("a failed provision is swallowed (onError), consumes the budget, stays down", async () => {
    const { target } = makeTarget({ provision: PROVISION });
    const control = fakeControl();
    control.newSession = async () => {
      throw new Error("tmux exploded");
    };
    const errors: unknown[] = [];
    const reviver = createReviver(target, {
      control,
      configDir: "/cfg",
      onError: (error) => errors.push(error),
    });
    expect(await reviver.revive()).toBe(false);
    expect(target.state.status).toBe("down");
    expect(errors).toHaveLength(1);
    expect(await reviver.revive()).toBe(false); // budget spent by the failed attempt
  });

  test("no provision block / not down → no attempt, budget untouched", async () => {
    const attachOnly = makeTarget({}).target; // no provision (attach-only, §4)
    const control = fakeControl();
    const reviver = createReviver(attachOnly, { control, configDir: "/cfg" });
    expect(await reviver.revive()).toBe(false);
    expect(control.calls.newSession).toHaveLength(0);

    const idle = makeTarget({ provision: PROVISION, status: "idle" }).target;
    const idleReviver = createReviver(idle, { control, configDir: "/cfg" });
    expect(await idleReviver.revive()).toBe(false); // not down — nothing to revive
    idle.state.to("down");
    expect(await idleReviver.revive()).toBe(true); // the no-op did NOT spend the budget
  });
});
