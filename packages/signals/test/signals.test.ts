import { describe, expect, test } from "bun:test";
import type { Signal } from "@teamai/core";
import type { RouteResult } from "@teamai/orchestrator";
import { buildSignal } from "../src/envelope";
import { type SignalRouter, sendSignal } from "../src/send";

const fixed = { newId: () => "fixed-id", now: () => 1700000000000 };

describe("buildSignal (§5.3, FR-18)", () => {
  test("fills id, ts and kind defaults", () => {
    expect(buildSignal({ from: "a", to: "b", payload: "hi" }, fixed)).toEqual({
      id: "fixed-id",
      from: "a",
      to: "b",
      kind: "message",
      ts: 1700000000000,
      payload: "hi",
    });
  });

  test("keeps an explicit id/ts and carries replyTo + origin when present", () => {
    const signal = buildSignal(
      {
        from: "a",
        to: "b",
        payload: "x",
        id: "m9",
        ts: 5,
        replyTo: "m1",
        origin: "routine:nightly",
      },
      fixed,
    );
    expect(signal.id).toBe("m9");
    expect(signal.ts).toBe(5);
    expect(signal.replyTo).toBe("m1");
    expect(signal.origin).toBe("routine:nightly");
  });

  test("omits replyTo/origin keys entirely when not given (exactOptional)", () => {
    const signal = buildSignal({ from: "a", to: "b", payload: "x" }, fixed);
    expect("replyTo" in signal).toBe(false);
    expect("origin" in signal).toBe(false);
  });
});

describe("sendSignal (§3.3, FR-19, §8.2)", () => {
  test("routes the built signal through the router and returns its verdict", async () => {
    const routed: Signal[] = [];
    const router: SignalRouter = {
      route: async (m) => {
        routed.push(m);
        return { ok: true, key: "b-session", filename: "f.json" } satisfies RouteResult;
      },
    };
    const result = await sendSignal(router, { from: "a", to: "b", payload: "hi" }, fixed);
    expect(result.ok).toBe(true);
    expect(routed).toHaveLength(1); // went THROUGH the router, not past it (§8.2)
    expect(routed[0]).toMatchObject({ from: "a", to: "b", payload: "hi", kind: "message" });
  });

  test("propagates a topology denial (the router is the single edge check, §10.2)", async () => {
    const router: SignalRouter = { route: async () => ({ ok: false, code: "TOPOLOGY_DENIED" }) };
    const result = await sendSignal(router, { from: "a", to: "stranger", payload: "x" }, fixed);
    expect(result).toEqual({ ok: false, code: "TOPOLOGY_DENIED" });
  });
});
