// What the sidebar actually PRINTS around the agent filter (§12.7, FR-176,
// T290). The matching rules live in agent-filter.test.ts; only the markup can
// answer where the panel sits, when it is there at all, and that it never
// filters silently — a shortened list must have its filter on screen.

import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PeerList } from "../src/PeerList";
import type { PeerInfo } from "../src/types";

const PEERS: readonly PeerInfo[] = [
  { name: "dev", type: "agent", status: "idle", queueDepth: 0, unread: 0 },
  { name: "writer", type: "agent", status: "down", queueDepth: 0, unread: 0 },
];

// The sidebar reads its persisted collapse prefs at render (prefs.ts) — outside
// a browser that is the only thing between it and renderToStaticMarkup.
beforeAll(() => {
  const data: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
});

const sidebar = (
  props: { filterPanel?: boolean; collapsed?: boolean; transport?: boolean } = {},
): string =>
  renderToStaticMarkup(
    <PeerList
      peers={PEERS}
      onSelect={() => undefined}
      flat={true}
      collapsed={props.collapsed === true}
      filterPanel={props.filterPanel}
      {...(props.transport === true ? { onTransport: () => undefined } : {})}
    />,
  );

describe("the filter panel", () => {
  test("off by prop ⇒ the sidebar looks exactly as it did before", () => {
    expect(sidebar()).not.toContain("agent-filter");
    expect(sidebar({ filterPanel: false })).not.toContain("agent-filter");
  });

  test("on ⇒ a name field and both sides of the all/online switch", () => {
    const html = sidebar({ filterPanel: true });
    expect(html).toContain('class="agent-filter"');
    expect(html).toContain('aria-label="Filter agents by name"');
    // both sides are printed; "All" is the one lit at rest
    expect(html).toContain('class="agent-filter-mode picked"');
    expect(html).toContain('aria-label="Show all agents"');
    expect(html).toContain('aria-label="Show only agents that are online"');
    expect(html).toContain(">All<");
    expect(html).toContain(">Online<");
  });

  test("it sits at the TOP — above the Transport entry and the rows (T291)", () => {
    const html = sidebar({ filterPanel: true, transport: true });
    const panel = html.indexOf('class="agent-filter"');
    const transport = html.indexOf("transport-entry");
    const firstRow = html.indexOf("peer-accent");
    expect(panel).toBeGreaterThanOrEqual(0);
    expect(transport).toBeGreaterThan(panel);
    expect(firstRow).toBeGreaterThan(transport);
  });

  test("no panel on the collapsed rail — and therefore no hidden filtering", () => {
    const html = sidebar({ filterPanel: true, collapsed: true });
    expect(html).not.toContain("agent-filter");
    // every peer is still on the rail
    expect(html).toContain("D");
    expect(html).toContain("W");
  });

  test("at rest it hides nothing: no counter, every agent listed", () => {
    const html = sidebar({ filterPanel: true });
    expect(html).not.toContain("agent-filter-count");
    expect(html).toContain(">dev<");
    expect(html).toContain(">writer<");
  });
});

// Persisted across reloads (T313, operator request) — the storage round-trip
// itself is prefs.test.ts; what only the markup can answer is that a restored
// filter comes back VISIBLE, and that it still cannot act with its panel off.
describe("the filter restored from storage (T313)", () => {
  const seed = (record: string): void =>
    localStorage.setItem("muxeon-pref:agent-filter-state", record);

  test("comes back with the needle in the field and the list already short", () => {
    seed('{"query":"dev","onlineOnly":false}');
    const html = sidebar({ filterPanel: true });
    expect(html).toContain('value="dev"');
    expect(html).toContain(">dev<");
    expect(html).not.toContain(">writer<");
    expect(html).toContain("agent-filter-count"); // the list says it is short
  });

  test("the restored ONLINE side lights its own button", () => {
    seed('{"query":"","onlineOnly":true}');
    const html = sidebar({ filterPanel: true });
    // "writer" is down — the restored switch is doing the work, not a needle
    expect(html).toContain(">dev<");
    expect(html).not.toContain(">writer<");
    // and the lit side is the ONLINE one, not "All" as at rest
    expect(html).toContain(
      'class="agent-filter-mode picked" aria-pressed="true" aria-label="Show only agents that are online"',
    );
  });

  test("with the panel off it restores NOTHING — the whole park is listed", () => {
    seed('{"query":"dev","onlineOnly":true}');
    const html = sidebar();
    expect(html).not.toContain("agent-filter");
    expect(html).toContain(">dev<");
    expect(html).toContain(">writer<");
  });
});
