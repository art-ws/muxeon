// The badge row as it renders (§19.9, FR-168). Three rules from the operator's
// request, checked in the markup rather than argued about:
//   - a count appears only from 2 up;
//   - the viewer's own reaction is marked (the accent class);
//   - a one-directional group/tag feed carries no reactions at all (§19.10).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../src/Chat";
import { ReactionsContext } from "../src/reactions-context";
import type { ChatRecord, PeerInfo, ReactionView } from "../src/types";

const TS = 1_700_000_000_000;

const record: ChatRecord = {
  id: "m1",
  from: "dev",
  to: "alex",
  kind: "message",
  ts: TS,
  payload: "done",
};

const agent: PeerInfo = { name: "dev", type: "agent", status: "idle", queueDepth: 0, unread: 0 };
const tag: PeerInfo = { name: "infra", type: "tag", status: null, queueDepth: 0, unread: 0 };

function markup(options: {
  peer?: PeerInfo;
  enabled?: boolean;
  reactions?: readonly ReactionView[];
}): string {
  const reactions = options.reactions ?? [];
  return renderToStaticMarkup(
    <ReactionsContext.Provider
      value={{
        enabled: options.enabled ?? true,
        reactionsOf: () => reactions,
        onChanged: () => undefined,
      }}
    >
      <ChatView
        peer={options.peer ?? agent}
        thread={{ records: [record], loaded: true }}
        phases={{}}
        isPeer={(name) => name !== "alex"}
        onLoadOlder={() => undefined}
      />
    </ReactionsContext.Provider>,
  );
}

const view = (over: Partial<ReactionView> = {}): ReactionView => ({
  key: "ok",
  emoji: "👍",
  count: 1,
  actors: [{ name: "alex", ts: TS }],
  mine: true,
  ...over,
});

describe("badges", () => {
  test("a single reaction shows the emoji and NO number", () => {
    const html = markup({ reactions: [view()] });
    expect(html).toContain("👍");
    expect(html).not.toContain("reaction-count");
  });

  test("two or more show the count", () => {
    const html = markup({
      reactions: [
        view({
          count: 2,
          actors: [
            { name: "alex", ts: TS },
            { name: "dev", ts: TS + 1 },
          ],
        }),
      ],
    });
    expect(html).toContain("reaction-count");
    expect(html).toContain(">2<");
  });

  test("the viewer's own reaction carries the accent class; someone else's does not", () => {
    expect(markup({ reactions: [view()] })).toContain("reaction-badge mine");
    expect(markup({ reactions: [view({ mine: false })] })).toContain('class="reaction-badge"');
  });

  test("the add trigger renders only when the server declares a palette (§19.2)", () => {
    expect(markup({})).toContain("reaction-add");
    expect(markup({ enabled: false })).not.toContain("reaction-add");
  });

  test("with reactions off, an EXISTING badge still renders (a catalog can be removed)", () => {
    const html = markup({ enabled: false, reactions: [view()] });
    expect(html).toContain("👍");
    expect(html).not.toContain("reaction-add");
  });

  test("a group/tag feed has no reaction bar at all (§19.10, decision Q3)", () => {
    const html = markup({ peer: tag, reactions: [view()] });
    expect(html).not.toContain("reaction-bar");
  });
});
