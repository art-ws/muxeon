// What the self-chat and the pair chat actually RENDER (§17.7, FR-128, T236).
// Two things only the markup can answer: which side a bubble takes now that the
// viewer's own name is a peer row like any other, and what the route line under
// it says — the operator saw a literal "(me) → agent" there.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../src/Chat";
import type { ChatRecord, PeerInfo } from "../src/types";

const ME = "operator-web";
const PEERS = new Set([ME, "researcher"]);

const record = (id: string, from: string, to: string): ChatRecord => ({
  id,
  from,
  to,
  kind: "message",
  ts: 1000,
  payload: `text of ${id}`,
});

const person = (name: string): PeerInfo => ({
  name,
  type: "user",
  status: null,
  presence: "online",
  queueDepth: 0,
  unread: 0,
});

const agent = (name: string): PeerInfo => ({ name, status: "idle", queueDepth: 0, unread: 0 });

const feed = (peer: PeerInfo, records: readonly ChatRecord[], self?: string): string =>
  renderToStaticMarkup(
    <ChatView
      peer={peer}
      thread={{ records, loaded: true }}
      phases={{}}
      isPeer={(name) => PEERS.has(name)}
      {...(self !== undefined ? { self } : {})}
      onLoadOlder={() => undefined}
    />,
  );

describe("bubble sides with a self row in the peer list (§17.7)", () => {
  test("my own message is MINE even though my name is a peer", () => {
    const out = feed(agent("researcher"), [record("out-1", ME, "researcher")], ME);
    expect(out).toContain('class="bubble-row mine"');
    expect(out).not.toContain('class="bubble-row theirs"');
  });

  test("the agent's reply is theirs", () => {
    const out = feed(agent("researcher"), [record("in-1", "researcher", ME)], ME);
    expect(out).toContain('class="bubble-row theirs"');
  });

  test("a note to self is mine — same name on both ends", () => {
    const out = feed(person(ME), [record("note-1", ME, ME)], ME);
    expect(out).toContain('class="bubble-row mine"');
  });

  test("without a self name the pre-§17 heuristic still decides", () => {
    const out = feed(agent("researcher"), [record("in-1", "researcher", "operator")]);
    expect(out).toContain('class="bubble-row theirs"');
  });
});

describe("the route line names names (FR-148, T236)", () => {
  test("no placeholder reaches the bubble — the real name does", () => {
    const out = feed(person(ME), [record("out-1", ME, "researcher")], ME);
    expect(out).toContain("operator-web → researcher");
    expect(out).not.toContain("(me)");
  });

  test("the self-chat shows both directions of every pair", () => {
    const out = feed(
      person(ME),
      [record("out-1", ME, "researcher"), record("in-1", "researcher", ME)],
      ME,
    );
    expect(out).toContain("operator-web → researcher");
    expect(out).toContain("researcher → operator-web");
  });
});
