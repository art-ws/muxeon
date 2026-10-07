// The OpenCode family (§5.2, §8.3, FR-11b) — the park's THIRD console runtime
// alongside claude and codex: `opencode --auto` (@opencode/cli) and `pi`
// (@earendil-works/pi-coding-agent). Live finding 2026-10-08 (T361): agents on
// these CLIs configured `type: auto` worked until a turn had to be *detected*,
// and then hung — `auto` knew only claude/codex busy markers, so a working pane
// read READY, the busy front never armed, `cur/` never completed, and the WIP
// limit (FR-104) walled off the queue: two agents sat at finished prompts while
// their turns were held open and the messages behind them could not drain (a
// peer report with a read-only diagnosis).
//
// Both CLIs keep the same shape as claude/codex — the input box stays visible in
// BOTH states, and only a status-line marker distinguishes "working" — so ready
// is again the ABSENCE of the marker (a negative probe, deliberately broad:
// misreading busy as ready injects over a running turn and false-completes it,
// §10.1, while an over-broad busy costs one more poll).
//
// Evidence, captured 2026-10-08 from LIVE scratch sessions (clean env, no park
// agents touched) with `tmux capture-pane`:
//
//   opencode (v2.0.23), IDLE status line:
//     `/private/tmp/zz-oc    shift+tab agents  ctrl+p commands`
//   opencode, BUSY status line (same position, a turn running):
//     `⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt       ↓ 1 shell  ctrl+p commands    /private/tmp/zz-oc`
//   → the marker is the phrase `esc interrupt` (note: NOT codex's `esc to
//     interrupt` — one word apart, which is why the codex probe missed it).
//
//   pi, IDLE: separator rows with no label —
//     `────…` above and below the composer.
//   pi, BUSY: the top separator row grows a spinner and a label —
//     `── ⠴ Working ─────…`  (observed 18×, glyph rotating ⠇⠴⠹…, label `Working`).
//   → the marker is a separator run carrying a braille spinner glyph and a label;
//     a plain separator (idle) and agent prose (no spinner glyph) both miss it.
//
// Composer: NOT declared for either CLI yet. opencode renders an unsent paste
// verbatim (a 40-line block, no `[Pasted Content …]` collapse) and its transcript
// quotes tool output with the SAME `┃` gutter, so no positive "our text is parked"
// marker was verified; declaring an unverified one would risk stalling turns
// (T359's gate) instead of merely losing them. Both CLIs DO ignore Enter while a
// turn runs (verified: a settled paste + Enter stayed in the composer), so the
// T359 recovery does not yet cover them — recorded as the follow-up, not guessed.
export const OPENCODE_BUSY_SOURCE = String.raw`[\s\S]*esc interrupt`;
export const OPENCODE_READY: RegExp = new RegExp(`^(?!${OPENCODE_BUSY_SOURCE})`);

/** Braille spinner glyphs — the rotating indicator pi puts on its separator row. */
const PI_SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const PI_BUSY_SOURCE = String.raw`[\s\S]*─{2,} *[${PI_SPINNER}] +\S+`;
export const PI_READY: RegExp = new RegExp(`^(?!${PI_BUSY_SOURCE})`);
