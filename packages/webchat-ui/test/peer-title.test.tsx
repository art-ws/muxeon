// The configured display label (§7.1/§17.2/§12.7, FR-156) — rendered, not
// reasoned about: the whole feature IS what the panel prints. Two rules hold
// everywhere a label appears: the `title` replaces the name when configured, and
// the NAME stays one hover away — it is what the operator addresses, routes and
// greps by. Agents and users share the field, so both are asserted.

import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountMenu } from "../src/AccountMenu";
import { ChatView } from "../src/Chat";
import { PeerList } from "../src/PeerList";
import { nameTooltip, peerLabel } from "../src/peer-surface";
import type { PeerInfo } from "../src/types";

const agent: PeerInfo = {
  name: "dev",
  title: "Разработчик",
  type: "agent",
  status: "idle",
  queueDepth: 0,
  unread: 0,
};
const plain: PeerInfo = { name: "ops", type: "agent", status: "idle", queueDepth: 0, unread: 0 };
const person: PeerInfo = {
  name: "alex",
  title: "Alexander",
  type: "user",
  status: null,
  presence: "online",
  queueDepth: 0,
  unread: 0,
};

// The sidebar reads its persisted collapse prefs at render (prefs.ts) — outside a
// browser that is the ONLY thing standing between it and renderToStaticMarkup.
beforeAll(() => {
  const data: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
});

const sidebar = (peers: readonly PeerInfo[], collapsed = false): string =>
  renderToStaticMarkup(
    <PeerList peers={peers} onSelect={() => undefined} flat={true} collapsed={collapsed} />,
  );

const header = (peer: PeerInfo): string =>
  renderToStaticMarkup(
    <ChatView
      peer={peer}
      thread={{ records: [], loaded: true }}
      phases={{}}
      isPeer={() => true}
      onLoadOlder={() => undefined}
    />,
  );

describe("display label (FR-156)", () => {
  test("the label is the title when configured, the name otherwise", () => {
    expect(peerLabel(agent)).toBe("Разработчик");
    expect(peerLabel(plain)).toBe("ops");
    expect(peerLabel(undefined)).toBe("");
  });

  test("only a titled peer grows a name tooltip — an untitled row is untouched", () => {
    expect(nameTooltip(agent)).toBe("dev");
    expect(nameTooltip(plain)).toBeUndefined();
  });

  test("a sidebar row prints the title and keeps the name in the tooltip", () => {
    const out = sidebar([agent]);
    expect(out).toContain(">Разработчик<");
    expect(out).not.toContain(">dev<");
    expect(out).toContain('title="dev"');
  });

  test("a user row follows the same rule — one field for agents and people", () => {
    const out = sidebar([person]);
    expect(out).toContain(">Alexander<");
    expect(out).toContain('title="alex"');
  });

  test("an untitled row renders exactly as before — no tooltip, name shown", () => {
    const out = sidebar([plain]);
    expect(out).toContain(">ops<");
    expect(out).not.toContain('title="ops"');
  });

  test("the collapsed rail takes its initial from the label, the tooltip from the name", () => {
    const out = sidebar([agent], true);
    expect(out).toContain(">Р<"); // "Разработчик", not "dev"
    expect(out).toContain('title="dev — idle"');
  });

  test("the chat header prints the title with the name in the tooltip", () => {
    const out = header(agent).split("</header>")[0] ?? "";
    expect(out).toContain('<strong title="dev">Разработчик</strong>');
  });

  test("an untitled chat header is unchanged", () => {
    const out = header(plain).split("</header>")[0] ?? "";
    expect(out).toContain("<strong>ops</strong>");
  });

  test("the account tooltip names the label AND the login", () => {
    const out = renderToStaticMarkup(
      <AccountMenu operator="alex" title="Alexander" onLogout={() => undefined} />,
    );
    expect(out).toContain('title="Alexander (alex) — account menu"');
  });

  test("without a title the account tooltip is the pre-FR-156 line", () => {
    const out = renderToStaticMarkup(<AccountMenu operator="alex" onLogout={() => undefined} />);
    expect(out).toContain('title="alex — account menu"');
  });
});
