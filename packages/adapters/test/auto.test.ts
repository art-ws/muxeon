import { describe, expect, test } from "bun:test";
import { AUTO_READY, createAutoAdapter } from "../src/auto";

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
    ).toContain("[teamai] from=a id=id1");
    expect(adapter.slashCommand("mcp")).toBe("/mcp");
    expect(adapter.slashCommand("model", "opus")).toBe("/model opus");
  });

  test("reuses the claude console-fallback scraper (claude panes scrape; codex → null)", () => {
    const adapter = createAutoAdapter({ stateDir: "/state" });
    const attr = "[teamai] from=op id=X-1";
    expect(adapter.extractReply?.(`❯ ${attr}\n⏺ 42\n──────`, attr)).toBe("42");
    // A codex `•` pane has no ⏺ blocks → null (nudge fires, no garbage forwarded).
    expect(adapter.extractReply?.(`› ${attr}\n• Ответ записан.\n──────`, attr)).toBeNull();
  });
});
