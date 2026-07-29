import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Message, Session } from "@teamai/core";
import { CODEX_READY, createCodexAdapter } from "../src/codex";

const session: Session = { name: "tl" };

function msg(): Message {
  return { id: "id1", from: "a", to: "b", kind: "message", ts: 0, payload: "hi" };
}

// Pane fixtures captured from LIVE codex (`gpt-5.5`) sessions on the stand
// (2026-07-05). The input box (`› …`) is visible in BOTH states — as with claude,
// only the working spinner / approval marker distinguishes them.
const PANE_IDLE = [
  "• Ответ оператору записан в reply.md, затем message.json удалён по контракту.",
  "─ Worked for 1m 15s ────────────────────────────────────────────────────────────",
  "",
  "› Implement {feature}",
  "",
  "  gpt-5.5 default · /srv/agents/tl",
].join("\n");

const PANE_BUSY = [
  "• Working (1m 10s • esc to interrupt)",
  "› Implement {feature}",
  "  gpt-5.5 default · /srv/agents/tl",
].join("\n");

// An agent blocked awaiting human approval: the footer carries the marker, no
// spinner. The turn is NOT done — the agent is frozen — so this is BUSY (T139-analog).
const PANE_APPROVAL = [
  "• Ответ записан в reply.md, входящее message.json удалено.",
  "─ Worked for 1m 17s ─────────────────────────────────────────────────────────────",
  "",
  "› Will this algorithm scale well?",
  "",
  "  gpt-5.5 default · /opt/ar… Side from main thread · main needs approval · Ctrl+C to return",
].join("\n");

// Boundary: codex prose/tool blocks and the placeholder input all use `•`/`›` but
// carry NO busy marker — must stay READY (must not false-trigger busy).
const PANE_IDLE_WITH_TOOL_BLOCKS = [
  "✔ You approved codex to always run commands that start with bin/dsh",
  "• Ran bin/dsh rm .teamai/inbox/linkcheck-dev-20260705/message.json",
  "  └ (no output)",
  "─────────────────────────────────────────────────────────────────────────────────",
  "› Explain this codebase",
  "  gpt-5.5 default · /srv/agents/dev",
].join("\n");

// A capture race that dropped the leading `•` glyph of the spinner still leaves the
// `esc to interrupt` phrase — must still read as NOT ready (busy stays broad).
const PANE_BUSY_TORN_CAPTURE = ["  Working (34s • esc to interrupt)", "› Implement {feature}"].join(
  "\n",
);

describe("codex adapter (§5.2, §8.3, FR-11/FR-11b)", () => {
  test("render produces attribution + payload", () => {
    expect(createCodexAdapter({ stateDir: "/state" }).render(msg())).toContain(
      "[teamai] from=a id=id1",
    );
  });

  test("type is codex", () => {
    expect(createCodexAdapter({ stateDir: "/state" }).type).toBe("codex");
  });

  test("detect declares the mandatory readyPrompt AND the opportunistic statusFile", () => {
    const adapter = createCodexAdapter({ stateDir: "/state" });
    expect(adapter.detect.readyPrompt).toBe(CODEX_READY);
    const statusFile = adapter.detect.statusFile;
    if (statusFile === undefined) throw new Error("expected the native accelerator");
    expect(statusFile(session)).toBe(join("/state", "adapters", "codex", "tl.json"));
  });

  test("readyPrompt: idle pane (no spinner) reads as ready", () => {
    expect(CODEX_READY.test(PANE_IDLE.trimEnd())).toBe(true);
  });

  test("readyPrompt: working spinner (esc to interrupt) reads as NOT ready", () => {
    expect(CODEX_READY.test(PANE_BUSY.trimEnd())).toBe(false);
  });

  test("readyPrompt: an approval-blocked turn reads as NOT ready", () => {
    expect(CODEX_READY.test(PANE_APPROVAL.trimEnd())).toBe(false);
  });

  test("readyPrompt: idle pane with codex tool/prose blocks still reads as ready", () => {
    expect(CODEX_READY.test(PANE_IDLE_WITH_TOOL_BLOCKS.trimEnd())).toBe(true);
  });

  test("readyPrompt: a capture-torn spinner (no glyph) still reads as NOT ready", () => {
    expect(CODEX_READY.test(PANE_BUSY_TORN_CAPTURE.trimEnd())).toBe(false);
  });

  test("adapter does not modify agent configuration — no install surface (FR-11b)", () => {
    expect("installHook" in createCodexAdapter({ stateDir: "/state" })).toBe(false);
  });

  test("no console-fallback scraper — codex relies on the file exchange (FR-47 rationale)", () => {
    expect(createCodexAdapter({ stateDir: "/state" }).extractReply).toBeUndefined();
  });

  test("slashCommand renders with and without args", () => {
    const adapter = createCodexAdapter({ stateDir: "/state" });
    expect(adapter.slashCommand("mcp")).toBe("/mcp");
    expect(adapter.slashCommand("review", "my changes")).toBe("/review my changes");
  });
});
