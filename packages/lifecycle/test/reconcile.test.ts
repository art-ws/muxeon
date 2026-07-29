// Liveness reconcile (FR-93, §5.1): sync AgentState.status with the live tmux
// session for a NON-busy agent. down + live ⇒ down→idle (origin external — not
// ours, so idle auto-teardown FR-92 leaves it alone); idle + gone ⇒ idle→down;
// busy is left to the per-turn down-probe (FR-16b) and not even probed; attach-only
// — it never provisions/spawns.

import { describe, expect, test } from "bun:test";
import { reconcileLiveness } from "../src/reconcile";
import { fakeControl, makeTarget } from "./helpers";

describe("reconcileLiveness (FR-93, §5.1)", () => {
  test("down + live session → idle, origin external (hand-started, not ours)", async () => {
    const { target } = makeTarget({ tmux: "a", status: "down" });
    target.state.setOrigin("system"); // we provisioned it, it died, operator restarted by hand
    const control = fakeControl({ present: ["a"] });

    const status = await reconcileLiveness(target, control);

    expect(status).toBe("idle");
    expect(target.state.status).toBe("idle");
    expect(target.state.origin).toBe("external"); // FR-92 must NOT reap a hand-started session
    expect(control.calls.newSession).toEqual([]); // attach-only: never spawns
  });

  test("idle + no session → down (killed while idle, out-of-band)", async () => {
    const { target } = makeTarget({ tmux: "a", status: "idle" });
    const control = fakeControl({ present: [] });

    const status = await reconcileLiveness(target, control);

    expect(status).toBe("down");
    expect(target.state.status).toBe("down");
  });

  test("busy is never touched — not even probed (FR-16b owns busy→down)", async () => {
    const { target } = makeTarget({ tmux: "a", status: "busy" });
    const base = fakeControl({ present: ["a"] });
    let probes = 0;
    const control = {
      ...base,
      hasSession: async (n: string) => {
        probes += 1;
        return base.hasSession(n);
      },
    };

    const status = await reconcileLiveness(target, control);

    expect(status).toBe("busy");
    expect(probes).toBe(0); // returns before probing — a live turn is never raced
  });

  test("down + no session → stays down (attach-only, no spawn)", async () => {
    const { target } = makeTarget({ tmux: "a", status: "down" });
    const control = fakeControl({ present: [] });

    const status = await reconcileLiveness(target, control);

    expect(status).toBe("down");
    expect(control.calls.newSession).toEqual([]); // never provisions — bring-up is FR-50/FR-51/operator
  });

  test("idle + live session → stays idle (no-op)", async () => {
    const { target } = makeTarget({ tmux: "a", status: "idle" });
    const control = fakeControl({ present: ["a"] });

    const status = await reconcileLiveness(target, control);

    expect(status).toBe("idle");
    expect(target.state.status).toBe("idle");
  });
});
