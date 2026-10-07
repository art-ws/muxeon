import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Message, Session } from "@muxeon/core";
import {
  CODEX_COMPOSER_EMPTY,
  CODEX_COMPOSER_PENDING,
  CODEX_READY,
  createCodexAdapter,
} from "../src/codex";

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
  "• Ran bin/dsh rm .muxeon/inbox/linkcheck-dev-20260705/message.json",
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
      "[muxeon] from=a id=id1",
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

// Composer state (FR-58, T359 — live finding 2026-10-08). Fixtures captured from
// LIVE panes on the stand: codex ignores Enter while its own turn runs, so a
// message injected into a busy agent parks in the composer while the pane still
// reads READY. These two markers are what let the driver see the difference.
const PANE_COMPOSER_EMPTY = [
  "• Ответ записан в reply.md.",
  "─ Worked for 1m 15s ────────────────────────────────────────────────────────────",
  "",
  "› Ask Codex to do anything",
  "",
  "  GPT-6-Sol high · /srv/agents/cto · 448K used",
  "  ? for shortcuts                                     ⚠ 3 warnings · f2 to view",
].join("\n");

// The operator's screenshot, 2026-10-08: the message stuck unsent in a busy pane
// for 55 minutes while the footer invited `tab to queue message`.
const PANE_COMPOSER_PENDING = [
  "• Waiting for background terminal (55m 26s • esc to interrupt) · 2 background t…",
  "",
  "› [Pasted Content 1328 chars]",
  "  GPT-6-Sol high · /srv/agents/dev1 · 778K used",
  "  tab to queue message",
].join("\n");

// A submitted message echoed in the transcript: same `›` prefix, RAW text. The
// pending marker must never match it — a completed turn read back as pending
// would park the driver on a message the agent already has.
const PANE_TRANSCRIPT_ECHO = [
  "› [muxeon] from=tl id=1145df87-bdb7-4126-9e78-a8ab8e37ac74CTO закрыл границу R…",
  "• Ran bin/dsh -s dev1-inspect 'tail -16 /srv/agents/dev1/.tmp/ac…",
  "  └       |  ELIFECYCLE  Command failed with exit code 1.",
  "",
  "› Ask Codex to do anything",
  "  GPT-6-Sol high · /srv/agents/dev1 · 831K used",
  "  ? for shortcuts                                      ⚠ 1 warning · f2 to view",
].join("\n");

describe("codex composer state (FR-58, T359)", () => {
  test("an unsent paste in the composer matches pending, not empty", () => {
    expect(CODEX_COMPOSER_PENDING.test(PANE_COMPOSER_PENDING)).toBe(true);
    expect(CODEX_COMPOSER_EMPTY.test(PANE_COMPOSER_PENDING)).toBe(false);
  });

  test("an idle composer matches empty (placeholder and bare forms), not pending", () => {
    expect(CODEX_COMPOSER_EMPTY.test(PANE_COMPOSER_EMPTY)).toBe(true);
    expect(CODEX_COMPOSER_PENDING.test(PANE_COMPOSER_EMPTY)).toBe(false);
    expect(CODEX_COMPOSER_EMPTY.test("› \n  gpt-5.5 default")).toBe(true);
    expect(CODEX_COMPOSER_EMPTY.test("› Implement {feature}")).toBe(false);
  });

  test("the transcript echo of a submitted message is NOT pending", () => {
    expect(CODEX_COMPOSER_PENDING.test(PANE_TRANSCRIPT_ECHO)).toBe(false);
  });

  test("the adapter declares the composer so the driver can hold the turn open", () => {
    const detect = createCodexAdapter({ stateDir: "/state" }).detect;
    expect(detect.composer?.pending).toBe(CODEX_COMPOSER_PENDING);
    expect(detect.composer?.empty).toBe(CODEX_COMPOSER_EMPTY);
  });
});
