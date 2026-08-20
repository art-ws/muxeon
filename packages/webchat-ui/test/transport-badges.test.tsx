// Reaction badges on the transport journal (§19.13, FR-182, decision Q1). The
// journal is where an operator sees agent↔agent traffic, so it is where the
// receipts must show — but it stays OBSERVATION: badges render, nothing places
// one, and `mine` never applies (nobody reacts from here).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactionBadges } from "../src/Reactions";
import type { ReactionView } from "../src/types";

const TS = 1_700_000_000_000;

const view = (over: Partial<ReactionView> = {}): ReactionView => ({
  key: "ok",
  emoji: "👍",
  count: 1,
  actors: [{ name: "tl", ts: TS }],
  mine: false,
  ...over,
});

const markup = (reactions: readonly ReactionView[]): string =>
  renderToStaticMarkup(<ReactionBadges reactions={reactions} />);

describe("journal badges (§19.13, FR-182)", () => {
  test("a single reaction shows the emoji and NO number", () => {
    const html = markup([view()]);
    expect(html).toContain("👍");
    expect(html).not.toContain("reaction-count");
  });

  test("two or more show the count", () => {
    const html = markup([
      view({
        count: 2,
        actors: [
          { name: "tl", ts: TS },
          { name: "dev1", ts: TS + 1 },
        ],
      }),
    ]);
    expect(html).toContain(">2<");
  });

  test("nothing is clickable and no picker is offered — the journal is read-only", () => {
    const html = markup([view()]);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("reaction-add");
    expect(html).toContain("reaction-badge static");
  });

  test("who placed it is in the tooltip, as in a chat", () => {
    expect(markup([view()])).toContain('title="tl"');
  });

  test("no reactions ⇒ no row at all (a journal row must not grow an empty strip)", () => {
    expect(markup([])).toBe("");
  });
});
