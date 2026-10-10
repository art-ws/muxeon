// §23.3/§23.4/§23.6 on the panel side: the pure helpers, the store's topic feeds
// and badges, and the header field as it renders.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../src/Chat";
import { TopicPicker } from "../src/TopicPicker";
import {
  type PanelState,
  applyEvent,
  applyOutgoing,
  applyTopicList,
  initialState,
  selectPeer,
  threadOf,
} from "../src/store";
import {
  ancestorsOf,
  depthOf,
  filterTopics,
  leafOf,
  loadLastTopic,
  resolveTopic,
  saveLastTopic,
  topicErrorText,
  topicThreadKey,
} from "../src/topics";
import type { ChatRecord, PeerInfo, TopicList, TopicView } from "../src/types";

const view = (id: string, path: string, extra: Partial<TopicView> = {}): TopicView => ({
  id,
  path,
  parentId: null,
  createdAt: 0,
  usage30d: 0,
  lastUsedAt: null,
  unread: 0,
  messageCount: 0,
  subtreeMessageCount: 0,
  ...extra,
});

const LIST: TopicList = {
  defaultId: "default",
  topics: [
    view("p", "Проект"),
    view("r", "Проект/Релиз", { parentId: "p", unread: 2 }),
    view("default", "Общая", { unread: 1 }),
  ],
};

describe("topic helpers (§23.4)", () => {
  test("path pieces and the thread key", () => {
    expect(leafOf("A/B/C")).toBe("C");
    expect(ancestorsOf("A/B/C")).toBe("A/B/");
    expect(ancestorsOf("A")).toBe("");
    expect(depthOf("A/B/C")).toBe(2);
    expect(topicThreadKey("dev", "t1")).not.toBe("dev");
    expect(topicThreadKey("dev", "t1").startsWith("dev")).toBe(true);
  });

  test("the search filters by full path, case-insensitively, keeping the order", () => {
    expect(filterTopics(LIST.topics, "релиз").map((t) => t.id)).toEqual(["r"]);
    expect(filterTopics(LIST.topics, "ПРОЕКТ").map((t) => t.id)).toEqual(["p", "r"]);
    expect(filterTopics(LIST.topics, "  ")).toBe(LIST.topics);
  });

  test("which topic a chat opens on: link, then memory, then the default", () => {
    expect(resolveTopic(LIST, "r", "p")).toEqual({ id: "r", stale: false });
    expect(resolveTopic(LIST, undefined, "p")).toEqual({ id: "p", stale: false });
    expect(resolveTopic(LIST, undefined, "gone")).toEqual({ id: "default", stale: false });
    expect(resolveTopic(LIST, "gone", "p")).toEqual({ id: "default", stale: true });
    expect(resolveTopic(undefined, "r", undefined)).toEqual({ id: "r", stale: false });
  });

  test("the last topic is remembered per (user, agent); a blocked storage is harmless", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveLastTopic("alex", "dev", "r", storage);
    expect(loadLastTopic("alex", "dev", storage)).toBe("r");
    expect(loadLastTopic("kim", "dev", storage)).toBeUndefined();
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
    };
    expect(loadLastTopic("alex", "dev", blocked)).toBeUndefined();
    saveLastTopic("alex", "dev", "r", blocked); // no throw
  });

  test("every refusal code has its own wording", () => {
    const codes = [
      "INVALID_TOPIC_PATH",
      "TOPIC_EXISTS",
      "TOPIC_CONFLICT",
      "DEFAULT_TOPIC",
      "TOPIC_NOT_FOUND",
    ];
    expect(new Set(codes.map(topicErrorText)).size).toBe(codes.length);
    expect(topicErrorText(undefined)).toBe("The topic operation failed");
  });
});

const ME = "alex";
const AGENT = "dev";
const agentRow: PeerInfo = { name: AGENT, type: "agent", status: "idle", queueDepth: 0, unread: 3 };
const record = (id: string, from = AGENT, extra: Partial<ChatRecord> = {}): ChatRecord => ({
  id,
  from,
  to: from === AGENT ? ME : AGENT,
  kind: "message",
  ts: 1,
  payload: id,
  ...extra,
});
const isOperator = (name: string): boolean => name === ME;

function withAgent(): PanelState {
  return applyTopicList({ ...initialState, peers: [agentRow] }, AGENT, LIST);
}

describe("store: topic feeds and badges (§23.3)", () => {
  test("an arrival lands in the whole log AND its topic feed", () => {
    const state = applyEvent(
      withAgent(),
      { type: "message", record: record("m1"), topicId: "r" },
      isOperator,
      {
        self: ME,
      },
    );
    expect(threadOf(state, AGENT).records.map((r) => r.id)).toEqual(["m1"]);
    expect(threadOf(state, topicThreadKey(AGENT, "r")).records.map((r) => r.id)).toEqual(["m1"]);
    expect(threadOf(state, ME).records.map((r) => r.id)).toEqual(["m1"]); // the self mirror
  });

  test("opening a topic reads only it; an arrival elsewhere still raises the badge", () => {
    let state = selectPeer(withAgent(), AGENT, "r");
    expect(state.openTopic).toBe("r");
    expect(state.peers[0]?.unread).toBe(1); // the default topic's 1 is left
    expect(state.topics[AGENT]?.topics.find((t) => t.id === "r")?.unread).toBe(0);
    state = applyEvent(
      state,
      { type: "message", record: record("in-r"), topicId: "r" },
      isOperator,
      { self: ME },
    );
    expect(state.peers[0]?.unread).toBe(1); // seen — it is the open topic
    state = applyEvent(
      state,
      { type: "message", record: record("in-d"), topicId: "default" },
      isOperator,
      {
        self: ME,
      },
    );
    expect(state.peers[0]?.unread).toBe(2);
    expect(state.topics[AGENT]?.topics.find((t) => t.id === "default")?.unread).toBe(2);
  });

  test("topics off: selecting the chat reads it all, as before §23", () => {
    const state = selectPeer(withAgent(), AGENT);
    expect(state.openTopic).toBeUndefined();
    expect(state.peers[0]?.unread).toBe(0);
  });

  test("an optimistic send is filed under its topic", () => {
    const state = applyOutgoing(withAgent(), record("o1", ME), ME, "p");
    expect(threadOf(state, topicThreadKey(AGENT, "p")).records.map((r) => r.id)).toEqual(["o1"]);
    expect(threadOf(state, AGENT).records.map((r) => r.id)).toEqual(["o1"]);
  });

  test("a topic delete removes exactly its ids from every feed of the pair", () => {
    let state = withAgent();
    for (const [id, topicId] of [
      ["a", "r"],
      ["b", "default"],
    ] as const) {
      state = applyEvent(state, { type: "message", record: record(id), topicId }, isOperator, {
        self: ME,
      });
    }
    state = applyEvent(
      state,
      { type: "history-cleared", peer: AGENT, topicId: "r", ids: ["a"] },
      isOperator,
      { self: ME },
    );
    expect(threadOf(state, AGENT).records.map((r) => r.id)).toEqual(["b"]);
    expect(threadOf(state, topicThreadKey(AGENT, "r")).records).toEqual([]);
    expect(threadOf(state, ME).records.map((r) => r.id)).toEqual(["b"]);
  });

  test("Clear chat (no ids) empties the topic feeds too", () => {
    let state = applyEvent(
      withAgent(),
      { type: "message", record: record("a"), topicId: "r" },
      isOperator,
      {
        self: ME,
      },
    );
    state = applyEvent(state, { type: "history-cleared", peer: AGENT }, isOperator, { self: ME });
    expect(threadOf(state, topicThreadKey(AGENT, "r")).records).toEqual([]);
  });

  test("topics-changed replaces the tree and re-settles the open topic's badge", () => {
    let state = selectPeer(withAgent(), AGENT, "p");
    state = applyEvent(
      state,
      {
        type: "topics-changed",
        peer: AGENT,
        defaultId: "default",
        topics: [view("p", "Проект", { unread: 4 }), view("default", "Общая", { unread: 2 })],
      },
      isOperator,
      { self: ME },
    );
    expect(state.topics[AGENT]?.topics.map((t) => t.unread)).toEqual([0, 2]);
    expect(state.peers[0]?.unread).toBe(2);
  });
});

describe("the header field (§23.4, FR-215)", () => {
  const field = (current: string): string =>
    renderToStaticMarkup(
      <TopicPicker peer={AGENT} list={LIST} current={current} onSelect={() => undefined} />,
    );

  test("shows the ancestors dimmed, the leaf, and the open topic's unread", () => {
    const html = field("r");
    expect(html).toContain('class="topic-ancestors">Проект/</span>');
    expect(html).toContain('class="topic-leaf">Релиз</span>');
    expect(html).toContain(">2</span>");
    expect(html).toContain('aria-expanded="false"');
  });

  test("sits in the agent chat header after the session clock", () => {
    const agent: PeerInfo = { ...agentRow, unread: 0 };
    const header =
      renderToStaticMarkup(
        <ChatView
          peer={agent}
          thread={{ records: [], loaded: true }}
          phases={{}}
          isPeer={() => true}
          onLoadOlder={() => undefined}
          topicControl={
            <TopicPicker peer={AGENT} list={LIST} current="p" onSelect={() => undefined} />
          }
        />,
      ).split("</header>")[0] ?? "";
    expect(header).toContain("topic-field");
    expect(header.indexOf("topic-field")).toBeGreaterThan(header.indexOf("chat-status"));
  });
});
