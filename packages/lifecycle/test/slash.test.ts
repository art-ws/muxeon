import { describe, expect, test } from "bun:test";
import { sendSlash } from "../src/slash";
import { fakeControl, makeTarget } from "./helpers";

describe("sendSlash (§4, FR-9, §8.3)", () => {
  test("renders via the adapter and injects literally, then Enter", async () => {
    const control = fakeControl({ present: ["rs"] });
    const kit = makeTarget({ tmux: "rs" });
    await sendSlash(kit.target, { control, name: "clear" });
    expect(control.calls.literal).toEqual([{ name: "rs", text: "/clear" }]);
    expect(control.calls.keys).toEqual([{ name: "rs", keys: ["Enter"] }]); // submitted
  });

  test("passes args through the adapter's command rendering", async () => {
    const control = fakeControl({ present: ["rs"] });
    const kit = makeTarget({ tmux: "rs" });
    await sendSlash(kit.target, { control, name: "model", args: "opus" });
    expect(control.calls.literal[0]?.text).toBe("/model opus");
  });
});
