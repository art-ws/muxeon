// What the header toolbar actually RENDERS (§12.10, FR-172, T279). The pure
// rules live in tools.test.ts; only the markup can answer the rest: that an
// empty pin set draws NO group at all, that a destructive shortcut starts
// unarmed (its second click is what fires), and that Export stays the plain
// <a download> the menu item is — a shortcut may not be safer or more dangerous
// than the item it repeats.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "../src/Toolbar";
import type { ToolId } from "../src/tools";
import type { PeerInfo } from "../src/types";

const AGENT: PeerInfo = {
  name: "researcher",
  status: "idle",
  queueDepth: 0,
  unread: 0,
  actions: { shutdown: true, reload: true, pause: true },
};

const bar = (enabled: readonly ToolId[], peer: PeerInfo | undefined, agentFilter = false): string =>
  renderToStaticMarkup(
    <Toolbar
      enabled={new Set(enabled)}
      peer={peer}
      agentFilter={agentFilter}
      onAgentFilter={() => undefined}
      onSettings={() => undefined}
      onLogout={() => undefined}
    />,
  );

describe("the toolbar group", () => {
  test("nothing pinned ⇒ no group in the topbar at all", () => {
    expect(bar([], AGENT)).toBe("");
  });

  test("a pinned tool renders as an icon button labelled with its target", () => {
    const html = bar(["console"], AGENT);
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Console — researcher"');
    expect(html).toContain("<svg"); // the same stroke icon as the menu item
  });

  test("Export is a download link, not a scripted button (FR-84)", () => {
    const html = bar(["export"], AGENT);
    expect(html).toContain('href="api/history/researcher/export"');
    expect(html).toContain("download");
  });

  test("a destructive shortcut renders unarmed — one click cannot fire it", () => {
    const html = bar(["shutdown"], AGENT);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('class="tool-button danger"');
  });

  test("Sign out is destructive here too — no menu to open first (FR-68)", () => {
    const html = bar(["logout"], undefined);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Sign out — sign out of the panel"');
  });

  test("Pause shows the peer's CURRENT state and asks for the opposite", () => {
    expect(bar(["pause"], AGENT)).toContain('aria-label="Pause — researcher"');
    expect(bar(["pause"], { ...AGENT, paused: true })).toContain(
      'aria-label="Resume — researcher"',
    );
  });

  // FR-177: the one button that toggles a panel instead of running an action —
  // it must say which way the next click goes and look different in each state,
  // or the toggle is a coin flip.
  test("the agent-filter button shows the panel's state and asks for the opposite", () => {
    const hidden = bar(["agent-filter"], undefined, false);
    expect(hidden).toContain('aria-label="Show the agent filter"');
    expect(hidden).toContain('aria-pressed="false"');
    expect(hidden).not.toContain("tool-button active");
    const shown = bar(["agent-filter"], undefined, true);
    expect(shown).toContain('aria-label="Hide the agent filter"');
    expect(shown).toContain('aria-pressed="true"');
    expect(shown).toContain("tool-button active");
  });

  test("it is a panel tool — it survives with no chat open, and never arms", () => {
    expect(bar(["agent-filter"], undefined)).toContain("tool-button");
    // a view toggle is not destructive: one click does it, no "Sure?" step
    expect(bar(["agent-filter"], undefined)).not.toContain("danger");
  });

  test("chat tools disappear with no chat open; panel tools stay", () => {
    const html = bar(["console", "clear", "settings"], undefined);
    expect(html).not.toContain("Console");
    expect(html).not.toContain("Clear chat");
    expect(html).toContain('aria-label="Settings — open the settings page"');
  });
});
