// The slash-command key DSL (T118/T119, FR-80). The old `esc: true` flag
// covered exactly one dialog shape (and was removed by T119); the general
// case is an arbitrary interleaving of keystrokes
// and pauses around the output capture. One small line-oriented DSL, parsed
// and VALIDATED at config load (§7.5 — a broken script is a config error, not
// a runtime surprise):
//
//   keys: "Down Down Enter 500ms capture Escape"
//
// Tokens, whitespace-separated:
//   - a delay:        <n>ms | <n>s            (per-step cap 10s, total 30s)
//   - a literal:      "double-quoted text"    (typed as-is, no key parsing)
//   - the capture:    capture                 (where the pane snapshot happens;
//                                              at most once, default — the END)
//   - a key:          any tmux send-keys name (Enter, Escape, Down, C-c, F5, y …)
//
// Steps before `capture` navigate the command's dialog; steps after it return
// the agent to the normal prompt (dialog commands end with "capture Escape").

export type KeyStep =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "delay"; readonly ms: number };

export interface KeyScript {
  /** Steps before the stabilized capture — dialog navigation. */
  readonly before: readonly KeyStep[];
  /** Steps after the capture — closing the dialog, back to the prompt. */
  readonly after: readonly KeyStep[];
}

/** A tmux send-keys token: plain keys (y, Enter, F5) and chords (C-c, M-x). */
const KEY_TOKEN = /^[A-Za-z0-9#~+_-]+$/;
const DELAY_TOKEN = /^(\d{1,5})(ms|s)$/;
const MAX_STEPS = 32;
const MAX_DELAY_MS = 10_000;
const MAX_TOTAL_DELAY_MS = 30_000;

/** Parses and validates a key script; throws Error with a human message. */
export function parseKeyScript(script: string): KeyScript {
  const before: KeyStep[] = [];
  const after: KeyStep[] = [];
  let captured = false;
  let totalDelay = 0;
  let steps = 0;

  const push = (step: KeyStep): void => {
    steps += 1;
    if (steps > MAX_STEPS) throw new Error(`key script exceeds ${MAX_STEPS} steps`);
    (captured ? after : before).push(step);
  };

  for (const token of tokenize(script)) {
    if (token.quoted) {
      if (token.text === "") throw new Error("empty literal in the key script");
      push({ kind: "literal", text: token.text });
      continue;
    }
    if (token.text === "capture") {
      if (captured) throw new Error('the key script names "capture" twice');
      captured = true;
      continue;
    }
    const delay = DELAY_TOKEN.exec(token.text);
    if (delay !== null) {
      const ms = Number(delay[1]) * (delay[2] === "s" ? 1000 : 1);
      if (ms > MAX_DELAY_MS) throw new Error(`delay "${token.text}" exceeds ${MAX_DELAY_MS}ms`);
      totalDelay += ms;
      if (totalDelay > MAX_TOTAL_DELAY_MS) {
        throw new Error(`key script delays exceed ${MAX_TOTAL_DELAY_MS}ms total`);
      }
      push({ kind: "delay", ms });
      continue;
    }
    if (KEY_TOKEN.test(token.text)) {
      push({ kind: "key", key: token.text });
      continue;
    }
    throw new Error(`unrecognized key-script token: ${JSON.stringify(token.text)}`);
  }
  if (steps === 0 && !captured) throw new Error("empty key script");
  return { before, after };
}

/** Whitespace-separated tokens; "double quotes" group a literal (no escapes). */
function tokenize(script: string): readonly { text: string; quoted: boolean }[] {
  const tokens: { text: string; quoted: boolean }[] = [];
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const end = script.indexOf('"', i + 1);
      if (end === -1) throw new Error("unterminated quoted literal in the key script");
      tokens.push({ text: script.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < script.length && !' \t\n"'.includes(script[end] ?? "")) end += 1;
    tokens.push({ text: script.slice(i, end), quoted: false });
    i = end;
  }
  return tokens;
}
