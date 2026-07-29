import { describe, expect, test } from "bun:test";
import { attach } from "../src/attach";
import { fakeControl, makeTarget } from "./helpers";

describe("attach (§4, FR-7, §5.1)", () => {
  test("a live session → idle", async () => {
    const kit = makeTarget({ tmux: "rs" });
    expect(await attach(kit.target, fakeControl({ present: ["rs"] }))).toBe("idle");
    expect(kit.target.state.status).toBe("idle");
  });

  test("a missing session → down (not fatal — the server still boots, §5.1)", async () => {
    const kit = makeTarget({ tmux: "rs" });
    expect(await attach(kit.target, fakeControl())).toBe("down");
    expect(kit.target.state.status).toBe("down");
  });

  test("attach touches nothing — agent configuration is inviolable (FR-11b, §5.2)", async () => {
    const kit = makeTarget({ tmux: "rs" });
    const control = fakeControl({ present: ["rs"] });
    await attach(kit.target, control);
    // attach only probes the session — no injections, no writes of any kind
    expect(control.calls.newSession).toHaveLength(0);
    expect(control.calls.literal).toHaveLength(0);
    expect(control.calls.keys).toHaveLength(0);
  });
});
