// The claude adapter (§5.2, §8.3, FR-11/FR-11b). Output detection is the reliable
// path — Muxeon never modifies agent configuration, so the native status file is
// only an opportunistic accelerator IF the agent's owner pre-installed (outside
// Muxeon) a Stop-hook writing { status, turn } to the convention path the
// dispatcher reads. Stateless; the stateDir is immutable configuration, not
// per-session state.

import { join } from "node:path";
import type { Session } from "@muxeon/core";
import { type Adapter, makeDefaultRender } from "./contract";

export interface ClaudeAdapterOptions {
  /** Base directory for the status-file convention (e.g. <config_dir>/state, §7.4). */
  readonly stateDir: string;
  /** Blob store dir <root>/blobs/ (§5.3) — blob refs render as local paths (FR-43, §12.5). */
  readonly blobsDir?: string;
}

// Output front detection (§5.2 п.2): Claude Code has no "ready prompt" of its own —
// the input box (`❯`) stays visible WHILE the agent works — so ready is the
// ABSENCE of the busy spinner line, e.g. `✢ Symbioting… (2m 22s · ↓ 6.6k tokens)`:
// a glyph at column 0 and a label ending in `…`. Confirmed against a live claude
// session (2026-06-04, T53; same UI in openclaude v0.1.7). The line is matched at
// line START — agent OUTPUT quoting a spinner is indented by the tool-result
// gutter and does not false-positive. Misreading busy as ready would inject over
// a running turn (§10.1), so the busy match is kept deliberately broad.
//
// T65 live finding: with an active TODO task the spinner label is the MULTI-WORD
// task name (`✳ Playing Bulls and Cows via Muxeon… (10s · ↓ 148 tokens)`) — the
// old single-word `\S+…` never matched, sawBusy never armed (driver.ts edge), and
// the turn hung forever. Also: tmux capture races the spinner redraw and drops
// characters (`… 34s)` without the `(`), so the `(…)` tail must NOT be required —
// busy is "glyph at column 0 + a label ending in `…`", nothing more.
//
// T139 live finding: an agent NOT running with `--dangerously-skip-permissions`
// blocks on an interactive approval dialog (`Do you want to proceed? ❯ 1. Yes …`)
// while waiting for a human. That dialog has NO spinner, so the spinner-only match
// read it as READY → the turn false-completed (the agent was mid-turn, not done),
// the reply-nudger piled on, and get_status reported idle while the agent was
// actually frozen (seen on a live stand: an agent stuck, the request never finishing). A
// blocked dialog is the OPPOSITE of ready — nothing may be injected over it and the
// turn is not done — so it counts as busy too. The stable, version- and
// language-agnostic marker is Claude's selection cursor: `❯ ` + a numbered option
// (`❯ 1.`), INDENTED inside the dialog box (so, unlike the spinner, leading
// whitespace is allowed). The bare input box (`❯ ` with no number) and a numbered
// list in agent prose (no `❯` prefix) both stay ready.
// The busy BODY — a spinner line OR an approval selector, matched ANYWHERE in the
// pane. Exported as a source string so the `auto` adapter can compose the union of
// claude+codex busy markers without duplicating (single source of truth).
export const CLAUDE_BUSY_SOURCE = String.raw`(?:[\s\S]*\n)?(?:[·✢✳✶✻✽∗*+] \S[^\n]*…|[ \t]*❯ \d+\.)`;
export const CLAUDE_READY: RegExp = new RegExp(`^(?!${CLAUDE_BUSY_SOURCE})`);

export function createClaudeAdapter(options: ClaudeAdapterOptions): Adapter {
  // Shared convention: <stateDir>/adapters/claude/<session>.json — computed the same
  // way by an external writer (if any, §5.2) and the dispatcher (reader).
  const statusFile = (session: Session): string =>
    join(options.stateDir, "adapters", "claude", `${session.name}.json`);

  return {
    type: "claude",
    render: makeDefaultRender(options.blobsDir !== undefined ? { blobsDir: options.blobsDir } : {}),
    detect: { readyPrompt: CLAUDE_READY, statusFile },
    extractReply: extractClaudeReply,
    slashCommand: (name: string, args?: string): string =>
      args !== undefined && args.length > 0 ? `/${name} ${args}` : `/${name}`,
  };
}

// Console-fallback (§8.2, FR-47): in the Claude Code UI the agent's own prose is
// the `⏺ `-prefixed blocks; tool results sit in indented `⎿` gutters, chrome is
// separators/prompt/status lines. Collect every ⏺ block AFTER the delivered
// message's attribution line (the LAST occurrence — redeliveries repeat it) and
// join them: that is what the agent "said" during the turn. Wrapped block lines
// continue indented and are folded back into their block.
export function extractClaudeReply(pane: string, attribution: string): string | null {
  const lines = pane.split("\n");
  const start = lines.findLastIndex((line) => line.includes(attribution));
  if (start === -1) return null;

  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trimEnd();
    if (line.startsWith("⏺ ")) {
      if (current !== null) blocks.push(current.join(" "));
      current = [line.slice(2).trim()];
      continue;
    }
    if (current === null) continue;
    // Block continuation: wrapped text is indented but is NOT a tool gutter (⎿),
    // a separator, a prompt, or the (indented) status bar / spinner chrome.
    const isContinuation =
      /^\s+\S/.test(line) &&
      !line.trimStart().startsWith("⎿") &&
      !line.trimStart().startsWith("⏵") &&
      !/^[\s─-]+$/.test(line);
    if (isContinuation) {
      current.push(line.trim());
    } else {
      blocks.push(current.join(" "));
      current = null;
    }
  }
  if (current !== null) blocks.push(current.join(" "));

  // Tool INVOCATIONS also render as ⏺ blocks — `Bash(date)`, `muxeon - send (MCP)(…)`.
  // The agent's prose never starts as `Name(`/`name - name (`; drop the calls.
  const prose = blocks.filter((block) => !/^\S+(\s-\s\S+)?\s?\(/.test(block));

  const text = prose.join("\n").trim();
  return text.length > 0 ? text : null;
}
