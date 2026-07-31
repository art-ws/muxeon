// The bubble's route line (§12.7, FR-148): every message names its sender and
// its recipient in front of the time. The bubble SIDE carries that information
// only while the chat has two distinct ends — a note to self (§17.7) has the
// same name on both, and a broadcast bubble (§15) says nothing about the target
// it went to. Rendered, not reasoned about: the meta line lives in JSX.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../src/Chat";
import type { ChatRecord, PeerInfo } from "../src/types";

const TS = 1_700_000_000_000;
const TIME = new Date(TS).toLocaleTimeString();

const record = (over: Partial<ChatRecord>): ChatRecord => ({
  id: "m1",
  from: "alex",
  to: "dev",
  kind: "message",
  ts: TS,
  payload: "hi",
  ...over,
});

const agent: PeerInfo = { name: "dev", type: "agent", status: "idle", queueDepth: 0, unread: 0 };
const me: PeerInfo = {
  name: "alex",
  type: "user",
  status: null,
  presence: "online",
  queueDepth: 0,
  unread: 0,
};
const tag: PeerInfo = { name: "infra", type: "tag", status: null, queueDepth: 0, unread: 0 };

// Everything after the meta span opens — the route must be its FIRST content.
const meta = (peer: PeerInfo, rec: ChatRecord): string =>
  renderToStaticMarkup(
    <ChatView
      peer={peer}
      thread={{ records: [rec], loaded: true }}
      phases={{}}
      isPeer={(name) => name !== "alex"}
      onLoadOlder={() => undefined}
    />,
  ).split('class="bubble-meta">')[1] ?? "";

describe("bubble route (§12.7, FR-148)", () => {
  test("an outgoing bubble names both ends BEFORE the time", () => {
    const out = meta(agent, record({}));
    expect(out).toStartWith('<span class="bubble-route">alex → dev</span>');
    expect(out.indexOf("bubble-route")).toBeLessThan(out.indexOf(TIME));
  });

  test("an incoming bubble reads the other way round", () => {
    expect(meta(agent, record({ from: "dev", to: "alex" }))).toContain(
      '<span class="bubble-route">dev → alex</span>',
    );
  });

  test("a note to self spells out both ends (§17.7) — the side cannot", () => {
    const out = meta(me, record({ from: "alex", to: "alex" }));
    expect(out).toContain('<span class="bubble-route">alex → alex</span>');
  });

  test("a broadcast bubble names the target it went to (§15)", () => {
    const out = meta(tag, record({ to: "infra" }));
    expect(out).toContain('<span class="bubble-route">alex → infra</span>');
  });

  test("the time itself is still there, after the route", () => {
    expect(meta(agent, record({}))).toContain(TIME);
  });
});
