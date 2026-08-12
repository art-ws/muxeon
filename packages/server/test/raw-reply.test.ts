// Raw-mode reply delivery (FR-88, §14.2): the captured console is routed back to
// the operator as the agent's reply with the deterministic `<id>:raw` id and
// `origin:"raw"` (so the panel renders it as-is).

import { describe, expect, test } from "bun:test";
import type { Message, Signal } from "@muxeon/core";
import { routeRawReply } from "../src/raw-reply";

function msg(id: string): Message {
  return {
    id,
    from: "operator-web",
    to: "researcher",
    kind: "message",
    ts: 1,
    payload: "ls",
    raw: true,
  };
}

function deps(output: string) {
  const routed: Signal[] = [];
  let captures = 0;
  return {
    routed,
    capturesRef: () => captures,
    deps: {
      agent: "researcher",
      capture: async () => {
        captures += 1;
        return output;
      },
      route: async (reply: Signal) => {
        routed.push(reply);
        return { ok: true };
      },
      now: () => 42,
    },
  };
}

describe("routeRawReply (FR-88)", () => {
  test("captures the console and routes it back with `<id>:raw` + origin raw", async () => {
    const kit = deps("total 24\n❯ ");
    expect(await routeRawReply(msg("m1"), kit.deps)).toBe(true);
    expect(kit.capturesRef()).toBe(1);
    expect(kit.routed).toEqual([
      {
        id: "m1:raw",
        from: "researcher",
        to: "operator-web",
        kind: "message",
        ts: 42,
        replyTo: "m1",
        payload: "total 24\n❯ ",
        origin: "raw",
      },
    ]);
  });

  test("an empty pane is still the honest as-is answer — routed, not dropped", async () => {
    const kit = deps("");
    expect(await routeRawReply(msg("m2"), kit.deps)).toBe(true);
    expect(kit.routed[0]?.payload).toBe("");
  });
});
