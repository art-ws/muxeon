// The auto adapter (§5.2, §8.3, FR-11/FR-11b). A single agent `type` that works
// for BOTH claude and codex sessions without pinning the runtime — the fix for the
// class of bug where an agent is configured `type: claude` but is actually launched
// as codex (or vice-versa) and its turns hang `busy` forever (2026-07-05 stand
// finding). Use it when the provisioner (`art …`) may launch either CLI, or when
// you simply don't want to track which is which.
//
// Detection is the UNION of both busy-markers: a pane is EITHER a claude or a codex
// session, and neither UI's idle state carries the other's busy markers (claude
// uses `[·✢…] …label…` / `❯ N.`; codex uses `esc to interrupt` / approval text with
// a `•` bullet glyph NOT in the claude set), so "ready = no marker from either" is
// safe. Composed from the two adapters' exported busy sources — single source of
// truth, so a tweak to either UI's detection flows here automatically.

import { CLAUDE_BUSY_SOURCE, CLAUDE_COMPOSER_EMPTY, extractClaudeReply } from "./claude";
import { CODEX_BUSY_SOURCE, CODEX_COMPOSER_EMPTY, CODEX_COMPOSER_PENDING } from "./codex";
import { type Adapter, makeDefaultRender } from "./contract";

export interface AutoAdapterOptions {
  /** Base directory for the status-file convention (unused here — see below). */
  readonly stateDir: string;
  /** Blob store dir <root>/blobs/ (§5.3) — blob refs render as local paths (FR-43, §12.5). */
  readonly blobsDir?: string;
}

/** Ready ⇔ the pane shows NO busy marker from claude OR codex. */
export const AUTO_READY: RegExp = new RegExp(`^(?!${CLAUDE_BUSY_SOURCE}|${CODEX_BUSY_SOURCE})`);

// Composer state (FR-58, T359) — composed the same way as the busy union, with
// one asymmetry that matters: `empty` is the union of BOTH idle composers (the
// completion gate must fire for whichever runtime is actually behind the pane,
// or every turn of a claude pane would block forever waiting for a `›`), while
// `pending` carries codex's paste marker ONLY. Claude does not strand messages
// while busy (it queues them on Enter), so claude panes never produce that
// marker — and a claude-specific "composer holds text" pattern would risk
// matching the transcript echo, which codex's collapse marker cannot (§ see
// codex.ts CODEX_COMPOSER_PENDING).
export const AUTO_COMPOSER_EMPTY: RegExp = new RegExp(
  `(?:${CLAUDE_COMPOSER_EMPTY.source})|(?:${CODEX_COMPOSER_EMPTY.source})`,
  "m",
);

export function createAutoAdapter(options: AutoAdapterOptions): Adapter {
  return {
    type: "auto",
    render: makeDefaultRender(options.blobsDir !== undefined ? { blobsDir: options.blobsDir } : {}),
    // No statusFile: the native-hook path is per-runtime (claude vs codex write to
    // different convention paths, §5.2) and `auto` can't know which — so it relies
    // solely on the reliable output-front path (readyPrompt), which needs zero
    // agent cooperation and covers both.
    detect: {
      readyPrompt: AUTO_READY,
      composer: { pending: CODEX_COMPOSER_PENDING, empty: AUTO_COMPOSER_EMPTY },
    },
    // Console-fallback: reuse the claude scraper — it extracts `⏺` prose blocks
    // (claude sessions) and returns null on a codex `•` pane (so codex agents fall
    // through to the nudge, no garbage forwarded). Best-effort, same as pinned types.
    extractReply: extractClaudeReply,
    slashCommand: (name: string, args?: string): string =>
      args !== undefined && args.length > 0 ? `/${name} ${args}` : `/${name}`,
  };
}
