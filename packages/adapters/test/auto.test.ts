import { describe, expect, test } from "bun:test";
import { AUTO_COMPOSER_EMPTY, AUTO_READY, createAutoAdapter } from "../src/auto";
import { CODEX_COMPOSER_PENDING } from "../src/codex";

// The whole point of `auto`: one type that reads busy/idle for EITHER runtime.
const CLAUDE_IDLE = ["⏺ Got it.", "❯ ", "  ⏵⏵ bypass permissions on"].join("\n");
const CLAUDE_BUSY = ["✢ Symbioting… (2m 22s · ↓ 6.6k tokens)", "❯ "].join("\n");
const CLAUDE_APPROVAL = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No"].join("\n");

const CODEX_IDLE = [
  "─ Worked for 1m 15s ────────────",
  "› Implement {feature}",
  "  gpt-5.5 default · /srv/agents/tl",
].join("\n");
const CODEX_BUSY = ["• Working (1m 10s • esc to interrupt)", "› Implement {feature}"].join("\n");
const CODEX_APPROVAL = [
  "› Will this scale?",
  "  gpt-5.5 default · … · main needs approval · Ctrl+C to return",
].join("\n");

describe("auto adapter (§5.2, §8.3, FR-11/FR-11b) — claude ∪ codex", () => {
  test("type is auto and it declares a readyPrompt", () => {
    const adapter = createAutoAdapter({ stateDir: "/state" });
    expect(adapter.type).toBe("auto");
    expect(adapter.detect.readyPrompt).toBe(AUTO_READY);
  });

  test("no statusFile — auto uses only the universal output-front path", () => {
    expect(createAutoAdapter({ stateDir: "/state" }).detect.statusFile).toBeUndefined();
  });

  test("reads CLAUDE idle as ready and CLAUDE busy/approval as NOT ready", () => {
    expect(AUTO_READY.test(CLAUDE_IDLE.trimEnd())).toBe(true);
    expect(AUTO_READY.test(CLAUDE_BUSY.trimEnd())).toBe(false);
    expect(AUTO_READY.test(CLAUDE_APPROVAL.trimEnd())).toBe(false);
  });

  test("reads CODEX idle as ready and CODEX busy/approval as NOT ready", () => {
    expect(AUTO_READY.test(CODEX_IDLE.trimEnd())).toBe(true);
    expect(AUTO_READY.test(CODEX_BUSY.trimEnd())).toBe(false);
    expect(AUTO_READY.test(CODEX_APPROVAL.trimEnd())).toBe(false);
  });

  test("render + slashCommand behave like the console default", () => {
    const adapter = createAutoAdapter({ stateDir: "/state" });
    expect(
      adapter.render({ id: "id1", from: "a", to: "b", kind: "message", ts: 0, payload: "hi" }),
    ).toContain("[muxeon] from=a id=id1");
    expect(adapter.slashCommand("mcp")).toBe("/mcp");
    expect(adapter.slashCommand("model", "opus")).toBe("/model opus");
  });

  test("reuses the claude console-fallback scraper (claude panes scrape; codex → null)", () => {
    const adapter = createAutoAdapter({ stateDir: "/state" });
    const attr = "[muxeon] from=op id=X-1";
    expect(adapter.extractReply?.(`❯ ${attr}\n⏺ 42\n──────`, attr)).toBe("42");
    // A codex `•` pane has no ⏺ blocks → null (nudge fires, no garbage forwarded).
    expect(adapter.extractReply?.(`› ${attr}\n• Ответ записан.\n──────`, attr)).toBeNull();
  });
});

// Composer state (FR-58, T359) — composed from both runtimes, with one
// asymmetry: `empty` is the UNION (the completion gate must fire for whichever
// CLI is behind the pane, or a claude pane would wait forever for a `›`), while
// `pending` is codex's paste marker only (claude queues on Enter and never
// strands; its composer with text is not distinguishable from the transcript
// echo, which codex's collapse marker is).
describe("auto composer state (FR-58, T359)", () => {
  test("the empty union matches both runtimes' idle composer", () => {
    expect(AUTO_COMPOSER_EMPTY.test(CLAUDE_IDLE)).toBe(true);
    expect(
      AUTO_COMPOSER_EMPTY.test(
        ["─ Worked for 1m 15s ──", "› Ask Codex to do anything", "  gpt-6-sol · /srv/a"].join("\n"),
      ),
    ).toBe(true);
    expect(
      AUTO_COMPOSER_EMPTY.test(["─ Worked for 1m 15s ──", "› ", "  gpt-6-sol · /srv/a"].join("\n")),
    ).toBe(true);
    // A composer HOLDING text is not empty — that is the parked-message state.
    expect(AUTO_COMPOSER_EMPTY.test(CODEX_IDLE)).toBe(false);
    expect(AUTO_COMPOSER_EMPTY.test(CLAUDE_BUSY)).toBe(true);
    expect(AUTO_COMPOSER_EMPTY.test(["❯ [muxeon] from=tl id=…"].join("\n"))).toBe(false);
    expect(AUTO_COMPOSER_EMPTY.test([" ❯ 1. Yes", "   2. No"].join("\n"))).toBe(false);
  });

  test("the adapter declares codex's pending marker and the empty union", () => {
    const detect = createAutoAdapter({ stateDir: "/state" }).detect;
    expect(detect.composer?.pending).toBe(CODEX_COMPOSER_PENDING);
    expect(detect.composer?.empty).toBe(AUTO_COMPOSER_EMPTY);
  });
});

// T361: the union must cover EVERY runtime the provisioner can launch. The park
// ran opencode/pi agents under `auto`, and both hung exactly like the
// codex-under-claude case the adapter exists to prevent.
describe("auto busy union covers opencode and pi (T361)", () => {
  const OPENCODE_BUSY = [
    "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    "   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt       ↓ 1 shell  ctrl+p commands    /srv/agents/…",
  ].join("\n");
  const PI_BUSY = [
    "── ⠴ Working ─────────────────────────────────────────────",
    "",
    "──────────────────────────────────────────────────────────",
  ].join("\n");

  test("opencode and pi busy panes read as NOT ready under auto", () => {
    expect(AUTO_READY.test(OPENCODE_BUSY)).toBe(false);
    expect(AUTO_READY.test(PI_BUSY)).toBe(false);
  });

  test("their idle panes read as ready", () => {
    expect(
      AUTO_READY.test(["  /srv/agents/test:main   215.0K (21%)  ctrl+p commands"].join("\n")),
    ).toBe(true);
    expect(AUTO_READY.test(["──────", "", "──────", "/srv/agents/test1 (main)"].join("\n"))).toBe(
      true,
    );
  });

  test("claude and codex panes still decide exactly as before", () => {
    expect(AUTO_READY.test(CLAUDE_BUSY)).toBe(false);
    expect(AUTO_READY.test(CODEX_BUSY)).toBe(false);
    expect(AUTO_READY.test(CLAUDE_IDLE)).toBe(true);
    expect(AUTO_READY.test(CODEX_IDLE)).toBe(true);
  });
});
