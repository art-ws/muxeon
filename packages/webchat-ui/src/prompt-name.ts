// The auto-name of a saved prompt (§20.7, FR-188): the first words of the text,
// turned into something a submenu row can carry. A PROPOSAL, never a verdict —
// the save dialog (§20.4) hands it to the user for editing, and the record's
// identity is its id (§20.2), not this string.
//
// A pure module under bun tests (the `filter.ts`/`quote.ts`/`tools.ts` discipline):
// no DOM, no i18n — the fallback for "nothing nameable here" is passed IN, so the
// translated "Untitled" stays with the component that has a dictionary.

/** Cap of the generated name; the store's own cap (120) is far above it. */
export const AUTO_NAME_MAX = 48;

/** Leading markup that says nothing about the prompt: fences, quotes, bullets, headings. */
const LEADING_MARKUP = /^(?:```+[\w-]*|~~~+|[#>*+•-]+|\d+[.)])\s*/u;
/** Emphasis left dangling once the leading half was cut ("**Важно" → "Важно"). */
const TRAILING_MARKS = /[\s*_`~.,;:!?—-]+$/u;

/**
 * A name from the first words of `text`, cut on a word boundary at AUTO_NAME_MAX
 * with an ellipsis. Whitespace (newlines included) collapses to single spaces:
 * the name is one line by construction, whatever the prompt looks like.
 */
export function autoPromptName(text: string, fallback = "Untitled"): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const bare = stripLeadingMarkup(flat).replace(TRAILING_MARKS, "");
  if (bare === "") return fallback; // an empty prompt, or nothing but markup
  if (bare.length <= AUTO_NAME_MAX) return bare;
  const cut = bare.slice(0, AUTO_NAME_MAX);
  const space = cut.lastIndexOf(" ");
  // A word boundary is preferred, but not at the price of a two-letter name: a
  // single long word is cut mid-word rather than thrown away.
  const head = space > AUTO_NAME_MAX / 3 ? cut.slice(0, space) : cut;
  return `${head.replace(TRAILING_MARKS, "")}…`;
}

function stripLeadingMarkup(line: string): string {
  let out = line;
  let previous = "";
  while (out !== previous) {
    previous = out;
    out = out.replace(LEADING_MARKUP, "").trimStart();
  }
  return out;
}
