// The chat header per peer kind (§12.7, §15, §17.7) — rendered, not reasoned
// about: the §17 regression that reached a live stand was invisible to the pure
// tests because it lived in a JSX branch. A person's chat opened as
// "broadcast tag (no members)" with a tag glyph, while their sidebar row was
// already a person. renderToStaticMarkup shows exactly what the header emits.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../src/Chat";
import type { PeerInfo } from "../src/types";

const EMPTY = { records: [], loaded: true } as const;

const header = (peer: PeerInfo | undefined): string =>
  renderToStaticMarkup(
    <ChatView
      peer={peer}
      thread={EMPTY}
      phases={{}}
      isPeer={() => true}
      onLoadOlder={() => undefined}
    />,
  ).split("</header>")[0] ?? "";

const agent: PeerInfo = { name: "dev", type: "agent", status: "idle", queueDepth: 0, unread: 0 };
const person: PeerInfo = {
  name: "operator-web",
  type: "user",
  status: null,
  presence: "online",
  queueDepth: 0,
  unread: 0,
  actions: { shutdown: false, reload: false, pause: true },
  commands: [],
};
const tag: PeerInfo = {
  name: "infra",
  type: "tag",
  status: null,
  queueDepth: 0,
  unread: 0,
  members: [],
};

describe("chat header (§12.7, §17.7)", () => {
  test("a person gets the AGENT header shape — dot, name, status, actions", () => {
    const out = header(person);
    expect(out).toContain('class="chat-header"');
    expect(out).toContain("<strong>operator-web</strong>");
    expect(out).toContain('class="status-dot online"'); // presence, not a session status
    expect(out).toContain("chat-actions"); // the same kebab as an agent
    // and NOTHING from the broadcast surface
    expect(out).not.toContain("broadcast");
    expect(out).not.toContain("no members");
  });

  test("an agent header is unchanged", () => {
    const out = header(agent);
    expect(out).toContain('class="status-dot idle"');
    expect(out).toContain("<strong>dev</strong>");
    expect(out).not.toContain("broadcast");
  });

  test("a tag still gets the broadcast header (§15)", () => {
    const out = header(tag);
    expect(out).toContain("broadcast-header");
    expect(out).toContain("broadcast tag (no members)");
  });

  test("a person's pause reads as do-not-disturb, not as an agent pause (§17.8)", () => {
    const out = header({ ...person, paused: true });
    expect(out).toContain("do not disturb");
    expect(out).toContain('class="status-dot online paused"');
    const agentPaused = header({ ...agent, paused: true });
    expect(agentPaused).toContain("paused");
    expect(agentPaused).not.toContain("do not disturb");
  });

  test("an offline person shows offline, never an empty status line", () => {
    expect(header({ ...person, presence: "offline" })).toContain(">offline<");
  });
});
