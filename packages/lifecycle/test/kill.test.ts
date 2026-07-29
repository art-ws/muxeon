import { describe, expect, test } from "bun:test";
import { kill } from "../src/kill";
import { fakeControl, makeTarget } from "./helpers";

describe("kill (§4, FR-9, §5.1)", () => {
  test("kills the session and goes down", async () => {
    const control = fakeControl({ present: ["rs"] });
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    expect(await kill(kit.target, control)).toBe("down");
    expect(control.calls.killed).toEqual(["rs"]);
    expect(kit.target.state.status).toBe("down");
  });

  test("killing an already-gone session is not an error (idempotent → down)", async () => {
    // killSession throws, but the session is absent afterward → treat as success.
    const control = fakeControl({ present: [], killThrows: true });
    const kit = makeTarget({ tmux: "rs", status: "down" });
    expect(await kill(kit.target, control)).toBe("down");
  });

  test("a kill failure on a STILL-present session propagates", async () => {
    const control = fakeControl({ present: ["rs"], killThrows: true });
    const kit = makeTarget({ tmux: "rs", status: "idle" });
    await expect(kill(kit.target, control)).rejects.toThrow(/kill failed/);
  });
});
