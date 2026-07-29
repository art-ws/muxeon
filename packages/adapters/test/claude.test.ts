import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Message, Session } from "@teamai/core";
import { CLAUDE_READY, createClaudeAdapter, extractClaudeReply } from "../src/claude";

const session: Session = { name: "researcher-session" };

function msg(): Message {
  return { id: "id1", from: "a", to: "b", kind: "message", ts: 0, payload: "hi" };
}

// Pane fixtures captured from a LIVE claude session (2026-06-04, T53). The input
// box (`❯`) is visible in BOTH states — only the spinner line distinguishes them.
const PANE_IDLE = [
  "⏺ Got it. I can see the TEAMAI smoke check message.",
  "──────────────",
  "❯ ",
  "──────────────",
  "  dev@workstation:/srv/teamai     36480 tokens",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

const PANE_BUSY = [
  "⏺ Bash(tmux capture-pane -t teamai -p)",
  "  ⎿  Waiting…",
  "✢ Symbioting… (2m 22s · ↓ 6.6k tokens · thought for 32s)",
  "──────────────",
  "❯ ",
  "──────────────",
  "  dev@workstation:/srv/teamai     129017 tokens",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

// Agent OUTPUT quoting a spinner is indented by the tool-result gutter — must
// still read as ready (no busy line at column 0).
const PANE_IDLE_QUOTING_SPINNER = [
  "⏺ the pane showed:",
  "  ⎿  ✢ Symbioting… (1m 42s · ↓ 4.6k tokens)",
  "❯ ",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

// T65 live fixtures (openclaude v0.1.7, 2026-06-05): with an active TODO task the
// spinner label is the multi-word task name; tmux capture racing the redraw can
// drop characters, including the `(` of the stats tail. Both are BUSY.
const PANE_BUSY_TASK_SPINNER = [
  "✳ Playing Bulls and Cows via TEAMAI… (10s · ↓ 148 tokens)",
  "──────────────",
  "❯ ",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

const PANE_BUSY_TORN_CAPTURE = [
  "· Playin  Bulls and Cows iia TEAMAI… 34s)", // redraw race ate chars and the "("
  "❯ ",
].join("\n");

// The persistent TODO widget between turns is indented — NOT a spinner.
const PANE_IDLE_TASK_WIDGET = [
  "⏺ Ход принят, жду следующий.",
  "  1 tasks (0 done, 1 in progress, 0 open)",
  "  ◼ Play Bulls and Cows via TEAMAI",
  "❯ ",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

// T139 live fixture (2026-06-26): an agent WITHOUT skip-permissions blocks
// on an interactive approval dialog. No spinner is shown — only the selection
// cursor (`❯ 1.`), indented inside the box. The turn is NOT done: the agent is
// frozen waiting for a human, so this is BUSY.
const PANE_PERMISSION_PROMPT = [
  "⏺ Bash(cd /srv/projects/metrics-svc; grep -rln prom-client …)",
  "  Find prom-client and metric definitions",
  "────────────────",
  " Bash command",
  "   cd /srv/projects/metrics-svc; grep -rln prom-client packages",
  " Compound command contains cd with output redirection - manual approval required",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and allow metrics-svc/ access and similar commands",
  "   3. No",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

// Boundary: a numbered list in the agent's OWN prose carries no `❯` selector — the
// only `❯` is the empty input box — so it stays READY (must not false-trigger busy).
const PANE_IDLE_NUMBERED_PROSE = [
  "⏺ План:",
  "  1. прочитать раннер",
  "  2. добавить метрики",
  "❯ ",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

describe("claude adapter (§5.2, §8.3, FR-11/FR-11b)", () => {
  test("render produces attribution + payload", () => {
    expect(createClaudeAdapter({ stateDir: "/state" }).render(msg())).toContain(
      "[teamai] from=a id=id1",
    );
  });

  test("detect declares the mandatory readyPrompt AND the opportunistic statusFile", () => {
    const adapter = createClaudeAdapter({ stateDir: "/state" });
    expect(adapter.detect.readyPrompt).toBe(CLAUDE_READY);
    const statusFile = adapter.detect.statusFile;
    if (statusFile === undefined) throw new Error("expected the native accelerator");
    expect(statusFile(session)).toBe(statusFile(session)); // deterministic
    expect(statusFile(session)).toBe(
      join("/state", "adapters", "claude", "researcher-session.json"),
    );
  });

  test("readyPrompt: idle pane (no spinner) reads as ready", () => {
    expect(CLAUDE_READY.test(PANE_IDLE.trimEnd())).toBe(true);
  });

  test("readyPrompt: busy pane (spinner line) reads as NOT ready", () => {
    expect(CLAUDE_READY.test(PANE_BUSY.trimEnd())).toBe(false);
  });

  test("readyPrompt: quoted spinner in indented agent output still reads as ready", () => {
    expect(CLAUDE_READY.test(PANE_IDLE_QUOTING_SPINNER.trimEnd())).toBe(true);
  });

  test("readyPrompt: a multi-word task spinner reads as NOT ready (T65)", () => {
    expect(CLAUDE_READY.test(PANE_BUSY_TASK_SPINNER.trimEnd())).toBe(false);
  });

  test("readyPrompt: a capture-torn spinner (no paren tail) still reads as NOT ready (T65)", () => {
    expect(CLAUDE_READY.test(PANE_BUSY_TORN_CAPTURE.trimEnd())).toBe(false);
  });

  test("readyPrompt: the persistent TODO widget between turns reads as ready (T65)", () => {
    expect(CLAUDE_READY.test(PANE_IDLE_TASK_WIDGET.trimEnd())).toBe(true);
  });

  test("readyPrompt: an open permission/approval dialog reads as NOT ready (T139)", () => {
    expect(CLAUDE_READY.test(PANE_PERMISSION_PROMPT.trimEnd())).toBe(false);
  });

  test("readyPrompt: a numbered list in agent prose still reads as ready (T139)", () => {
    expect(CLAUDE_READY.test(PANE_IDLE_NUMBERED_PROSE.trimEnd())).toBe(true);
  });

  test("adapter does not modify agent configuration — no install surface (FR-11b)", () => {
    const adapter = createClaudeAdapter({ stateDir: "/state" });
    expect("installHook" in adapter).toBe(false);
  });

  test("slashCommand renders with and without args", () => {
    const adapter = createClaudeAdapter({ stateDir: "/state" });
    expect(adapter.slashCommand("clear")).toBe("/clear");
    expect(adapter.slashCommand("model", "opus")).toBe("/model opus");
  });
});

describe("extractClaudeReply — console-fallback (§8.2, FR-47)", () => {
  const ATTR = "[teamai] from=operator-web id=ABC-1";

  test("extracts the ⏺ blocks after the attribution, skipping chrome and tool gutters", () => {
    const pane = [
      "⏺ старый ответ на прошлое сообщение",
      `❯ ${ATTR}`,
      "сколько будет 5+5?",
      '[reply via the teamai MCP tool: send(to="operator-web",',
      'replyTo="ABC-1") — your answer as plain-text payload]',
      "⏺ Bash(date)",
      "  ⎿  Thu Jun  5 00:00:00 2026",
      "⏺ 5+5=10",
      "──────────────",
      "❯ ",
      "──────────────",
      "  dev@workstation:/srv/teamai     29488 tokens",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(extractClaudeReply(pane, ATTR)).toBe("5+5=10"); // the Bash(date) tool call is filtered
  });

  test("folds wrapped (indented) block lines back into the block", () => {
    const pane = [
      `❯ ${ATTR}`,
      "вопрос",
      "⏺ Это длинный ответ, который",
      "  переносится на следующую строку.",
      "──────────────",
    ].join("\n");
    expect(extractClaudeReply(pane, ATTR)).toBe(
      "Это длинный ответ, который переносится на следующую строку.",
    );
  });

  test("uses the LAST attribution occurrence (redeliveries repeat it)", () => {
    const pane = [`❯ ${ATTR}`, "⏺ первый ответ", `❯ ${ATTR}`, "⏺ второй ответ", "──────"].join(
      "\n",
    );
    expect(extractClaudeReply(pane, ATTR)).toBe("второй ответ");
  });

  test("nothing after the attribution → null (the nudge fires instead)", () => {
    expect(extractClaudeReply(`❯ ${ATTR}\nвопрос\n──────\n❯ `, ATTR)).toBeNull();
    expect(extractClaudeReply("совсем другой текст", ATTR)).toBeNull();
  });
});
