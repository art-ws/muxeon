// The codex adapter (§5.2, §8.3, FR-11/FR-11b). OpenAI Codex CLI (`gpt-5.5`) is a
// second console agent type alongside claude; the two coexist — the registry maps
// each agent's config `type` to its adapter, so a park can mix them freely.
// Output detection is the reliable path (TEAMAI never modifies agent config);
// stateless, like the claude adapter.

import { join } from "node:path";
import type { Session } from "@teamai/core";
import { type Adapter, makeDefaultRender } from "./contract";

export interface CodexAdapterOptions {
  /** Base directory for the status-file convention (e.g. <config_dir>/state, §7.4). */
  readonly stateDir: string;
  /** Blob store dir <root>/blobs/ (§5.3) — blob refs render as local paths (FR-43, §12.5). */
  readonly blobsDir?: string;
}

// Output front detection (§5.2 п.2), confirmed against LIVE codex sessions on the
// stand (2026-07-05: agents tl/ceo/cto/dev/test/devops running `gpt-5.5`). Like
// Claude Code, codex keeps its input box (`› …`) visible in BOTH states, so ready
// is the ABSENCE of a "the turn is not done" marker — two of them:
//
//   1. WORKING spinner — `• Working (1m 10s • esc to interrupt)`. The stable,
//      version- and label-agnostic marker is the phrase `esc to interrupt` (codex
//      prints it only while a turn runs). Note codex uses the `•` glyph for its
//      OWN prose/tool blocks too (`• Ran …`, `• Ответ записан …`), so the glyph
//      alone can't mean busy — the `esc to interrupt` phrase is what discriminates.
//   2. APPROVAL block — a turn blocked awaiting human approval is the OPPOSITE of
//      ready (nothing may be injected over it, the turn is not done). Codex shows
//      it in the footer: `… · main needs approval · Ctrl+C to return`. Markers:
//      `needs approval` / `Ctrl+C to return` (mirrors the claude T139 finding).
//
// Busy is kept deliberately BROAD (match the marker anywhere, not anchored to a
// column) for the same reason as claude: misreading busy as ready injects over a
// running turn (§10.1) and false-completes it, whereas an over-broad busy only
// makes the driver wait one more poll. A capture race (§ claude T65) that drops
// the `•` glyph still leaves the phrase intact, so detection survives it.
//
// Why this adapter exists (2026-07-05 live finding): codex agents configured as
// `type: claude` never cleared busy — the claude spinner regex (`glyph …label…`)
// never matches codex's `• Working … esc to interrupt`, so the driver's `sawBusy`
// edge never armed (driver.ts#awaitOutput) and every dispatched codex turn hung
// `busy` forever; `restart <agent>` then hung too (it awaits the idle edge).
// The busy BODY — a working-spinner phrase OR an approval marker, matched ANYWHERE.
// Exported as a source string so the `auto` adapter composes the claude+codex union
// without duplicating (single source of truth).
export const CODEX_BUSY_SOURCE = String.raw`[\s\S]*(?:esc to interrupt|needs approval|Ctrl\+C to return)`;
export const CODEX_READY: RegExp = new RegExp(`^(?!${CODEX_BUSY_SOURCE})`);

export function createCodexAdapter(options: CodexAdapterOptions): Adapter {
  // Shared convention: <stateDir>/adapters/codex/<session>.json — an external
  // status-writer (if any, §5.2) and the dispatcher compute the SAME path.
  const statusFile = (session: Session): string =>
    join(options.stateDir, "adapters", "codex", `${session.name}.json`);

  return {
    type: "codex",
    render: makeDefaultRender(options.blobsDir !== undefined ? { blobsDir: options.blobsDir } : {}),
    detect: { readyPrompt: CODEX_READY, statusFile },
    // No extractReply (console-fallback, FR-47): codex renders its own prose AND
    // its tool actions under the same `•` glyph (`• Ответ записан …` vs `• Ran …`),
    // with no reliable prose/chrome split like claude's `⏺`/`⎿`. Scraping it would
    // ship tool-action noise to peers, so codex agents rely on the file exchange
    // (reply.md) / send; a turn closed without a reply simply earns the nudge
    // (FR-45) — nothing garbled is forwarded. (The claude scraper already returns
    // null on a `•` pane, so omitting this is no regression.)
    slashCommand: (name: string, args?: string): string =>
      args !== undefined && args.length > 0 ? `/${name} ${args}` : `/${name}`,
  };
}
