import { describe, expect, test } from "bun:test";
import type { Signal } from "@muxeon/core";
import { ReplyNudger, nudgePayload } from "../src/nudge";

const OPERATORS = new Set(["operator-web"]);

function operatorMsg(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "m1",
    from: "operator-web",
    to: "qwen",
    kind: "message",
    ts: 0,
    payload: "привет",
    ...overrides,
  };
}

function makeNudger(): { nudger: ReplyNudger; routed: Signal[] } {
  const routed: Signal[] = [];
  const nudger = new ReplyNudger({
    isOperator: (name) => OPERATORS.has(name),
    route: async (message) => {
      routed.push(message);
    },
    now: () => 42,
  });
  return { nudger, routed };
}

describe("ReplyNudger (§8.2, FR-45)", () => {
  test("a reply-less operator message earns exactly one nudge with a deterministic id", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg); // no send happened during the turn
    expect(routed).toHaveLength(1);
    const nudge = routed[0];
    expect(nudge?.id).toBe("m1:nudge"); // deterministic → done/-dedup kills repeats (§10.9)
    expect(nudge?.kind).toBe("nudge");
    expect(nudge?.from).toBe("operator-web"); // the edge already exists (§10.2)
    expect(nudge?.to).toBe("qwen");
    expect(nudge?.replyTo).toBe("m1");
    expect(nudge?.payload).toBe(nudgePayload(msg));
  });

  test("an agent send to the sender during the turn suppresses the nudge", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.beginTurn("qwen", msg);
    nudger.recordSend("qwen", "operator-web"); // the reply, as the router reports it
    await nudger.afterTurn("qwen", msg);
    expect(routed).toHaveLength(0);
  });

  test("a send to SOMEONE ELSE does not count as the reply", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.beginTurn("qwen", msg);
    nudger.recordSend("qwen", "muxeon"); // talked to a peer, not to the sender
    await nudger.afterTurn("qwen", msg);
    expect(routed).toHaveLength(1);
  });

  test("a send BEFORE the turn window does not count (window, not history)", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.recordSend("qwen", "operator-web"); // an old reply, before this delivery
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg);
    expect(routed).toHaveLength(1); // still nudged — nothing within THIS turn
  });

  test("a nudge itself never expects a reply — no second nudge, no loop", async () => {
    const { nudger, routed } = makeNudger();
    const nudge = operatorMsg({ id: "m1:nudge", kind: "nudge", replyTo: "m1" });
    expect(nudger.expectsReply(nudge)).toBe(false);
    nudger.beginTurn("qwen", nudge);
    await nudger.afterTurn("qwen", nudge);
    expect(routed).toHaveLength(0);
  });

  test("agent-to-agent messages never nudge (T61: window opens, scrape only)", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg({ from: "muxeon" }); // a peer agent, not an operator
    expect(nudger.expectsReply(msg)).toBe(true); // the window DOES open (T61)…
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg); // …but no scrape hook and no nudge for a peer
    expect(routed).toHaveLength(0);
  });

  test("afterTurn without a beginTurn window is a no-op (recovery edge)", async () => {
    const { nudger, routed } = makeNudger();
    await nudger.afterTurn("qwen", operatorMsg());
    expect(routed).toHaveLength(0);
  });
});

describe("console-fallback scrape (§8.2, FR-47)", () => {
  test("a scraped terminal answer is routed as the agent's reply and suppresses the nudge", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg, async () => "5+5=10");
    expect(routed).toHaveLength(1);
    const reply = routed[0];
    expect(reply?.id).toBe("m1:scrape"); // deterministic → dedup (§10.9)
    expect(reply?.kind).toBe("message");
    expect(reply?.from).toBe("qwen"); // the agent's words, attributed to the agent
    expect(reply?.to).toBe("operator-web");
    expect(reply?.replyTo).toBe("m1");
    expect(reply?.payload).toBe("5+5=10");
    expect(reply?.origin).toBe("tmux-fallback"); // the mechanism is honest
  });

  test("an empty scrape falls back to the nudge", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg, async () => null);
    expect(routed).toHaveLength(1);
    expect(routed[0]?.kind).toBe("nudge");
  });

  test("a throwing scrape falls back to the nudge (best-effort)", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg, async () => {
      throw new Error("tmux gone");
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]?.kind).toBe("nudge");
  });

  test("an agent that DID send is neither scraped nor nudged", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg();
    nudger.beginTurn("qwen", msg);
    nudger.recordSend("qwen", "operator-web");
    await nudger.afterTurn("qwen", msg, async () => "терминальный дубль");
    expect(routed).toHaveLength(0); // the real send wins; no scrape double-delivery
  });
});

describe("inter-agent fallback scope (§8.2, FR-47, T61)", () => {
  test("a peer message's console answer is scraped and routed to the peer", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg({ from: "muxeon" }); // agent → agent
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg, async () => "50");
    expect(routed).toHaveLength(1);
    const reply = routed[0];
    expect(reply?.id).toBe("m1:scrape");
    expect(reply?.from).toBe("qwen");
    expect(reply?.to).toBe("muxeon"); // the peer sender, not an operator
    expect(reply?.origin).toBe("tmux-fallback");
  });

  test("an empty scrape on a peer message earns NOTHING — no nudge for peers", async () => {
    const { nudger, routed } = makeNudger();
    const msg = operatorMsg({ from: "muxeon" });
    nudger.beginTurn("qwen", msg);
    await nudger.afterTurn("qwen", msg, async () => null); // e.g. a pure ack, rightly ignored
    expect(routed).toHaveLength(0);
  });

  test("a scraped message never opens a window itself — no scrape ping-pong", async () => {
    const { nudger, routed } = makeNudger();
    const scraped = operatorMsg({ from: "qwen", to: "muxeon", origin: "tmux-fallback" });
    expect(nudger.expectsReply(scraped)).toBe(false);
    nudger.beginTurn("muxeon", scraped);
    await nudger.afterTurn("muxeon", scraped, async () => "console echo");
    expect(routed).toHaveLength(0); // one fallback hop max per genuine message
  });
});
