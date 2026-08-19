// The quoted-message preview (§12.7, FR-178, T292 — operator request): what a
// reply shows OF the message it answers. Pure and DOM-free, so `bun test` pins
// the trimming rules without a browser.
//
// A quote is a POINTER, not a copy: one line, short, enough to recognise which
// message is meant — the full text is one click away (the quote scrolls the feed
// to it) and the agent reads it by id (FR-179). Pasting whole messages back into
// the feed would double every long answer on screen for no new information.

import { type ChatRecord, payloadParts } from "./types";

/** How much of the quoted text a preview keeps before the ellipsis. */
export const QUOTE_MAX_CHARS = 120;

/**
 * One line out of a record's payload: newlines and runs of whitespace collapse
 * to single spaces (a quote must not grow the bubble it sits in), the result is
 * cut at `max` on a WORD boundary when there is one nearby — a cut mid-word
 * reads like a typo, and the ellipsis already says "there is more".
 *
 * A message with no text answers with its attachments instead ("📎 2" would be
 * an emoji, §12.7-FR-77 — so the count is spelled by the caller's dictionary):
 * `undefined` text and a blob count let the view print its own label.
 */
export function quoteText(record: ChatRecord, max: number = QUOTE_MAX_CHARS): string | undefined {
  const { text } = payloadParts(record.payload);
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat === "") return undefined;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** How many attachments the quoted message carries — the fallback label's number. */
export const quoteBlobCount = (record: ChatRecord): number =>
  payloadParts(record.payload).blobs.length;

/**
 * Does this reply's quote add anything on screen (T292)? A reply whose target is
 * the record DIRECTLY above it quotes what the reader is already looking at —
 * and every agent answer carries `replyTo` for correlation (§8.3), so without
 * this rule the feed would grow a quote line on nearly every bubble. The
 * reference itself is never dropped: it stays in the record, in the envelope the
 * agent received, and in the deep link.
 */
export function quoteWorthShowing(records: readonly ChatRecord[], index: number): boolean {
  const record = records[index];
  if (record?.replyTo === undefined) return false;
  return records[index - 1]?.id !== record.replyTo;
}

/**
 * The one line a quote prints — the composer chip and the bubble header share it
 * (FR-178). A record the thread has not loaded yet says so plainly (clicking the
 * quote still pages back to it); a record with no text names its attachments
 * instead of showing an empty quote. `t` is the panel's translator (FR-78), passed
 * in so this module stays DOM- and context-free.
 */
export function quotePreview(record: ChatRecord | undefined, t: (text: string) => string): string {
  if (record === undefined) return t("not loaded yet — click to open");
  const text = quoteText(record);
  if (text !== undefined) return text;
  const blobs = quoteBlobCount(record);
  return blobs > 0
    ? t("{count} attachment(s)").replace("{count}", String(blobs))
    : t("empty message");
}
