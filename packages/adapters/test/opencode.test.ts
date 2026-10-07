import { describe, expect, test } from "bun:test";
import { OPENCODE_READY, PI_READY } from "../src/opencode";

// Pane fixtures captured 2026-10-08 (T361) from LIVE sessions with
// `tmux capture-pane`: the park's own test (opencode) / test1 (pi) panes at their
// prompts, and scratch sessions (clean env, park untouched) mid-turn. They are the
// verbatim screens the ready probes must separate.

// test (opencode --auto) at its prompt: the blocked node of tl's report.
const OPENCODE_IDLE = [
  "   Вердикт отправлен через muxeon send к tl.",
  "  ┃",
  "  ┃",
  "  ┃",
  "  ┃  Build auto · Muse Spark 1.3 Free OpenCode Zen · xhigh",
  "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "  /srv/agents/test:main                     215.0K (21%)  ctrl+p commands",
].join("\n");

// the same session mid-turn (scratch replay, `sleep 120`): only the status-line
// left half changes — progress ticks and the interrupt hint appear.
const OPENCODE_BUSY = [
  "  ┃  Build auto · Muse Spark 1.3 Free OpenCode Zen · xhigh",
  "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt       ↓ 1 shell  ctrl+p commands    /private/tmp/zz-oc",
].join("\n");

// test1 (pi) at its prompt: separators with no label, status counters beneath.
const PI_IDLE = [
  " Жду от TL отдельного полного наряда на финальный свод/gate.",
  "────────────────────────────────────────────────────────────────",
  "",
  "────────────────────────────────────────────────────────────────",
  "/srv/agents/test1 (main)",
  "↑6.3k ↓3.0k R61k CH98.1% $0.006 1.1%/1.0M (auto)      deepseek-flash • high",
  "OR: 467 models",
].join("\n");

// the same CLI mid-turn: the top separator row carries a spinner glyph + a label.
const PI_BUSY = [
  "── ⠴ Working ───────────────────────────────────────────────────",
  "",
  "────────────────────────────────────────────────────────────────",
  "/private/tmp/zz-pi",
  "0.1%/1.0M (auto)                              gemini-3.1-pro-preview • medium",
].join("\n");

describe("opencode busy probe (§5.2, FR-11b, T361)", () => {
  test("idle status line reads ready; a running turn reads busy", () => {
    expect(OPENCODE_READY.test(OPENCODE_IDLE.trimEnd())).toBe(true);
    expect(OPENCODE_READY.test(OPENCODE_BUSY.trimEnd())).toBe(false);
  });

  test("the probe is opencode's `esc interrupt`, not codex's `esc to interrupt`", () => {
    // The one-word difference is why the codex probe missed these panes entirely.
    expect(OPENCODE_BUSY.includes("esc interrupt")).toBe(true);
    expect(OPENCODE_BUSY.includes("esc to interrupt")).toBe(false);
    expect(OPENCODE_READY.test("• Working (1m 10s • esc to interrupt)")).toBe(true);
  });

  test("pi's separator label is not opencode's marker and vice versa", () => {
    expect(OPENCODE_READY.test(PI_BUSY)).toBe(true); // pi busy ≠ opencode busy
    expect(PI_READY.test(OPENCODE_BUSY)).toBe(true);
  });
});

describe("pi busy probe (§5.2, FR-11b, T361)", () => {
  test("plain separators (idle) read ready; a labelled separator reads busy", () => {
    expect(PI_READY.test(PI_IDLE.trimEnd())).toBe(true);
    expect(PI_READY.test(PI_BUSY.trimEnd())).toBe(false);
  });

  test("separator runs in agent prose do NOT read as busy (no spinner glyph)", () => {
    expect(PI_READY.test(["Итог:", "── таблица ──", "значения ниже"].join("\n"))).toBe(true);
    expect(PI_READY.test(["──────", "│ a │ b │", "──────"].join("\n"))).toBe(true);
  });
});
