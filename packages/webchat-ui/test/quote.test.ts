// What a reply SHOWS of the message it answers (§12.7, FR-178, T292). A quote is
// a pointer, so the rules that matter are: it stays one short line, and it only
// appears where it tells the reader something they cannot already see.

import { describe, expect, test } from "bun:test";
import {
  QUOTE_MAX_CHARS,
  quoteBlobCount,
  quotePreview,
  quoteText,
  quoteWorthShowing,
} from "../src/quote";
import type { ChatRecord } from "../src/types";

const record = (extra: Partial<ChatRecord> = {}): ChatRecord => ({
  id: "m1",
  from: "operator-web",
  to: "dev",
  kind: "message",
  ts: 1,
  payload: "hello",
  ...extra,
});

const t = (text: string): string => text; // the identity translator (FR-78 default)

describe("the quoted line", () => {
  test("a short text passes through untouched", () => {
    expect(quoteText(record({ payload: "restart the stand" }))).toBe("restart the stand");
  });

  test("newlines and runs of whitespace collapse — a quote is ONE line", () => {
    expect(quoteText(record({ payload: "run this:\n\n  bun   test\n" }))).toBe(
      "run this: bun test",
    );
  });

  test("a long text is cut at a word boundary and marked with an ellipsis", () => {
    const long = "word ".repeat(60).trim();
    const cut = quoteText(long !== "" ? record({ payload: long }) : record());
    expect(cut).toBeDefined();
    expect((cut as string).length).toBeLessThanOrEqual(QUOTE_MAX_CHARS + 1);
    expect(cut as string).toEndWith("…");
    expect(cut as string).not.toContain("wor…"); // never mid-word when a space is near
  });

  test("a run with no spaces is still cut — the bubble must not stretch", () => {
    const cut = quoteText(record({ payload: "x".repeat(400) })) as string;
    expect(cut.length).toBe(QUOTE_MAX_CHARS + 1); // 120 chars + the ellipsis
  });

  test("a text-less payload has no line of its own", () => {
    expect(quoteText(record({ payload: { blobs: [{ blob: "b1" }] } }))).toBeUndefined();
    expect(quoteText(record({ payload: "   " }))).toBeUndefined();
  });

  test("attachments are counted so the view can name them", () => {
    expect(quoteBlobCount(record({ payload: { blobs: [{ blob: "a" }, { blob: "b" }] } }))).toBe(2);
    expect(quoteBlobCount(record())).toBe(0);
  });
});

describe("the preview the chip and the bubble share", () => {
  test("text wins", () => {
    expect(quotePreview(record({ payload: "ship it" }), t)).toBe("ship it");
  });

  test("no text ⇒ the attachments are named, with their count", () => {
    const media = record({ payload: { blobs: [{ blob: "a" }, { blob: "b" }] } });
    expect(quotePreview(media, t)).toBe("2 attachment(s)");
  });

  test("a record the thread has not loaded says so — it never renders blank", () => {
    expect(quotePreview(undefined, t)).toBe("not loaded yet — click to open");
  });

  test("an empty message is called empty, not missing", () => {
    expect(quotePreview(record({ payload: "" }), t)).toBe("empty message");
  });
});

describe("when a quote is worth printing", () => {
  // no `origin` ⇒ an agent's answer, whose replyTo is machine correlation (§8.3)
  const thread: readonly ChatRecord[] = [
    record({ id: "a" }),
    record({ id: "b" }),
    record({ id: "c", replyTo: "b" }), // answers the bubble directly above
    record({ id: "d", replyTo: "a" }), // answers something older
    record({ id: "e" }),
  ];

  test("no reference ⇒ no quote", () => {
    expect(quoteWorthShowing(thread, 0)).toBe(false);
    expect(quoteWorthShowing(thread, 4)).toBe(false);
  });

  test("an AGENT answering the bubble above adds nothing — it is already on screen", () => {
    expect(quoteWorthShowing(thread, 2)).toBe(false);
  });

  test("an agent answering something OLDER prints its quote — there it is news", () => {
    expect(quoteWorthShowing(thread, 3)).toBe(true);
  });

  // T294, the operator's correction: their first live reply answered the bubble
  // right above it and rendered as an ordinary message. A quote someone CHOSE to
  // make is the feature — it prints regardless of what sits above.
  test("a HUMAN reply always prints its quote, adjacent or not", () => {
    const chosen: readonly ChatRecord[] = [
      record({ id: "a" }),
      record({ id: "b", replyTo: "a", origin: "webchat" }),
    ];
    expect(quoteWorthShowing(chosen, 1)).toBe(true);
  });

  test("any channel origin counts as chosen — console included (FR-170)", () => {
    const typed: readonly ChatRecord[] = [
      record({ id: "a" }),
      record({ id: "b", replyTo: "a", origin: "console" }),
    ];
    expect(quoteWorthShowing(typed, 1)).toBe(true);
  });

  test("the first record of a loaded page keeps its quote (nothing above it)", () => {
    expect(quoteWorthShowing([record({ id: "z", replyTo: "gone" })], 0)).toBe(true);
  });
});
