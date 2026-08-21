// What the chat RENDERS around a reply (§12.7, FR-178, T292). The trimming rules
// live in quote.test.ts; only the markup can answer where the quote appears, that
// it links to the quoted message, and that the reply affordance shows up where a
// message can actually be answered — and nowhere else.

import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../src/Chat";
import { Composer } from "../src/Composer";
import type { ChatRecord, PeerInfo } from "../src/types";

const AGENT: PeerInfo = {
  name: "dev",
  type: "agent",
  status: "idle",
  queueDepth: 0,
  unread: 0,
};
const GROUP: PeerInfo = {
  name: "backend",
  type: "group",
  status: null,
  queueDepth: 0,
  unread: 0,
  members: ["dev"],
};

const record = (extra: Partial<ChatRecord>): ChatRecord => ({
  id: "m1",
  from: "operator-web",
  to: "dev",
  kind: "message",
  ts: 1,
  payload: "hello",
  ...extra,
});

// The composer reads its persisted draft at mount (draft-store.ts) — outside a
// browser that is the only thing between it and renderToStaticMarkup.
beforeAll(() => {
  const data: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
  };
});

const chat = (
  records: readonly ChatRecord[],
  options: { peer?: PeerInfo; reply?: boolean } = {},
): string =>
  renderToStaticMarkup(
    <ChatView
      peer={options.peer ?? AGENT}
      thread={{ records, loaded: true }}
      phases={{}}
      isPeer={(name) => name === "dev"}
      self="operator-web"
      onLoadOlder={() => undefined}
      {...(options.reply === false ? {} : { onReply: () => undefined })}
    />,
  );

describe("the quote inside a bubble", () => {
  const thread = [
    record({ id: "old", payload: "run the full suite, please" }),
    record({ id: "mid", from: "dev", to: "operator-web", payload: "done" }),
    record({ id: "new", payload: "again", replyTo: "old" }),
  ];

  test("a reply to an older message prints author + one trimmed line", () => {
    const html = chat(thread);
    expect(html).toContain("bubble-quote");
    expect(html).toContain("run the full suite, please");
    expect(html).toContain('class="bubble-quote-author">operator-web<');
  });

  test("the quote LINKS to the quoted message — the deep-link route (FR-75)", () => {
    // the click handler is not in static markup, but the target must be a live
    // button (not a dead span) for the anchor route to be reachable
    expect(chat(thread)).toContain('<button type="button" class="bubble-quote"');
    expect(chat(thread)).not.toContain('class="bubble-quote" disabled');
  });

  test("an AGENT answering the bubble directly above prints NO quote (T292)", () => {
    const tight = [
      record({ id: "a", payload: "ping" }),
      record({ id: "b", from: "dev", to: "operator-web", payload: "pong", replyTo: "a" }),
    ];
    expect(chat(tight)).not.toContain("bubble-quote");
  });

  // T294: the operator's own reply to the message right above rendered as a plain
  // bubble — a quote someone chose to make must always show, and be clickable.
  test("a HUMAN reply to the bubble above still prints its quote", () => {
    const tight = [
      record({ id: "a", from: "dev", to: "operator-web", payload: "готово" }),
      record({ id: "b", payload: "отлично получилось", replyTo: "a", origin: "webchat" }),
    ];
    const html = chat(tight);
    expect(html).toContain("bubble-quote");
    expect(html).toContain("готово");
    expect(html).toContain('<button type="button" class="bubble-quote"');
  });

  test("a quote whose target is not loaded still renders, and says so", () => {
    const html = chat([record({ id: "x", payload: "again", replyTo: "pruned" })]);
    expect(html).toContain("bubble-quote");
    expect(html).toContain("not loaded yet");
  });
});

describe("the reply affordance", () => {
  test("a 1:1 bubble offers Reply", () => {
    expect(chat([record({ id: "a" })])).toContain('title="Reply to this message"');
  });

  test("a text-less bubble offers it too — an attachment is answerable", () => {
    const media = record({ id: "a", payload: { blobs: [{ blob: "b1", name: "log.txt" }] } });
    expect(chat([media])).toContain('title="Reply to this message"');
  });

  test("a broadcast feed offers none — a fan-out has no single envelope (§15.6)", () => {
    expect(chat([record({ id: "a", to: "backend" })], { peer: GROUP })).not.toContain(
      "Reply to this message",
    );
  });

  test("it sits in the BOTTOM row, next to the reaction trigger (operator request 2026-08-21)", () => {
    const html = chat([record({ id: "a" })]);
    // the button carries the reaction row's own class…
    expect(html).toContain('class="reaction-add reply"');
    // …and stands after the row opens, not up in the copy/source hover strip
    expect(html.indexOf("Reply to this message")).toBeGreaterThan(html.indexOf("reaction-bar"));
    const hoverStrip = html.slice(
      html.indexOf('class="msg-actions"'),
      html.indexOf("reaction-bar"),
    );
    expect(hoverStrip).not.toContain("Reply to this message");
  });

  test("a stand with NO reaction catalog still offers it — the row exists for the button alone", () => {
    // the tests render with the default (disabled) reactions context, so this is
    // literally the catalog-less panel: the badges and picker are gone, reply is not
    const html = chat([record({ id: "a" })]);
    expect(html).not.toContain("Add reaction");
    expect(html).toContain("Reply to this message");
  });

  test("without the callback there is no button at all", () => {
    expect(chat([record({ id: "a" })], { reply: false })).not.toContain("Reply to this message");
  });
});

describe("the composer's reply chip", () => {
  const composer = (replyTo?: { id: string; author: string; preview: string }): string =>
    renderToStaticMarkup(
      <Composer
        peer="dev"
        onSend={async () => undefined}
        {...(replyTo !== undefined ? { replyTo, onCancelReply: () => undefined } : {})}
      />,
    );

  test("no reply ⇒ no chip", () => {
    expect(composer()).not.toContain("reply-chip");
  });

  test("a reply names who is being answered and shows the trimmed line", () => {
    const html = composer({ id: "old", author: "dev", preview: "the stand is up" });
    expect(html).toContain("reply-chip");
    expect(html).toContain('class="reply-chip-author">dev<');
    expect(html).toContain("the stand is up");
    expect(html).toContain('aria-label="Cancel the reply"');
  });
});
