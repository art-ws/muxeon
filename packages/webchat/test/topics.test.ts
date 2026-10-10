// §23 (FR-208…FR-214): the pure topic model — paths, the derived tree, rename
// and delete of subtrees, the default topic's limits, and the usage order.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOPIC_ID,
  DEFAULT_TOPIC_PATH,
  type TopicCounts,
  TopicError,
  type TopicState,
  createTopic,
  initialTopicState,
  normalizeTopicPath,
  parseTopicState,
  pruneTopicUsage,
  recordTopicUse,
  removeTopic,
  renameTopic,
  subtreeOf,
  topicViews,
} from "../src/topics";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function ids(): () => string {
  let n = 0;
  return () => `t${++n}`;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof TopicError) return error.code;
    throw error;
  }
  return undefined;
}

const paths = (state: TopicState): string[] => state.topics.map((topic) => topic.path).sort();
const noCounts = new Map<string, TopicCounts>();

describe("topic paths (§23.1)", () => {
  test("segments are trimmed and NFC; `/` separates levels", () => {
    expect(normalizeTopicPath("  Проект / Релиз ")).toBe("Проект/Релиз");
    expect(normalizeTopicPath("é")).toBe("é");
  });

  test("empty segments, leading/trailing slash, dots and control chars are refused", () => {
    for (const bad of ["", "/A", "A/", "A//B", "A/./B", "..", "A/\u0007", 42, " / "]) {
      expect(codeOf(() => normalizeTopicPath(bad))).toBe("INVALID_TOPIC_PATH");
    }
  });

  test("an over-long path is refused", () => {
    expect(codeOf(() => normalizeTopicPath("x".repeat(300)))).toBe("INVALID_TOPIC_PATH");
  });
});

describe("create / rename / remove (§23.1, §23.3)", () => {
  test("a fresh pair has exactly the default topic", () => {
    const state = initialTopicState(NOW);
    expect(state.topics).toEqual([
      { id: DEFAULT_TOPIC_ID, path: DEFAULT_TOPIC_PATH, createdAt: NOW },
    ]);
  });

  test("creating A/B/C creates the missing ancestors in one step", () => {
    const state = initialTopicState(NOW);
    const leaf = createTopic(state, "A/B/C", NOW, ids());
    expect(leaf.path).toBe("A/B/C");
    expect(paths(state)).toEqual(["A", "A/B", "A/B/C", DEFAULT_TOPIC_PATH].sort());
  });

  test("paths are unique regardless of case; the typed case is kept", () => {
    const state = initialTopicState(NOW);
    createTopic(state, "Release", NOW, ids());
    expect(codeOf(() => createTopic(state, "release", NOW, ids()))).toBe("TOPIC_EXISTS");
    expect(state.topics.some((topic) => topic.path === "Release")).toBe(true);
  });

  test("rename of a parent re-paths the subtree and keeps every id", () => {
    const state = initialTopicState(NOW);
    const next = ids();
    createTopic(state, "A/B", NOW, next);
    const before = new Map(state.topics.map((topic) => [topic.path, topic.id]));
    const moved = renameTopic(state, before.get("A") as string, "X/Y", NOW, next);
    expect(moved.map((topic) => topic.path).sort()).toEqual(["X/Y", "X/Y/B"]);
    expect(state.topics.find((topic) => topic.path === "X/Y/B")?.id).toBe(before.get("A/B"));
    expect(paths(state)).toContain("X"); // the new ancestor was created
    expect(paths(state)).not.toContain("A");
  });

  test("a case-only rename re-spells the subtree", () => {
    const state = initialTopicState(NOW);
    const next = ids();
    createTopic(state, "a/b", NOW, next);
    const a = state.topics.find((topic) => topic.path === "a")?.id as string;
    renameTopic(state, a, "A", NOW, next);
    expect(paths(state)).toEqual(["A", "A/b", DEFAULT_TOPIC_PATH].sort());
  });

  test("moving under itself or onto an existing path is TOPIC_CONFLICT", () => {
    const state = initialTopicState(NOW);
    const next = ids();
    createTopic(state, "A/B", NOW, next);
    createTopic(state, "C", NOW, next);
    const a = state.topics.find((topic) => topic.path === "A")?.id as string;
    expect(codeOf(() => renameTopic(state, a, "A/B/Z", NOW, next))).toBe("TOPIC_CONFLICT");
    expect(codeOf(() => renameTopic(state, a, "c", NOW, next))).toBe("TOPIC_CONFLICT");
    expect(paths(state)).toEqual(["A", "A/B", "C", DEFAULT_TOPIC_PATH].sort()); // untouched
  });

  test("the default topic renames only to a root path and is never removed", () => {
    const state = initialTopicState(NOW);
    expect(codeOf(() => renameTopic(state, DEFAULT_TOPIC_ID, "A/General", NOW, ids()))).toBe(
      "DEFAULT_TOPIC",
    );
    renameTopic(state, DEFAULT_TOPIC_ID, "General", NOW, ids());
    expect(state.topics[0]?.path).toBe("General");
    expect(codeOf(() => removeTopic(state, DEFAULT_TOPIC_ID))).toBe("DEFAULT_TOPIC");
  });

  test("remove takes the subtree and its usage, and nothing else", () => {
    const state = initialTopicState(NOW);
    const next = ids();
    createTopic(state, "A/B", NOW, next);
    createTopic(state, "AB", NOW, next); // a sibling sharing a prefix, not a child
    const a = state.topics.find((topic) => topic.path === "A")?.id as string;
    const b = state.topics.find((topic) => topic.path === "A/B")?.id as string;
    recordTopicUse(state, b, NOW);
    expect(
      subtreeOf(state, a)
        .map((topic) => topic.path)
        .sort(),
    ).toEqual(["A", "A/B"]);
    expect(removeTopic(state, a).sort()).toEqual([a, b].sort());
    expect(paths(state)).toEqual(["AB", DEFAULT_TOPIC_PATH].sort());
    expect(state.usage[b]).toBeUndefined();
    expect(codeOf(() => removeTopic(state, a))).toBe("TOPIC_NOT_FOUND");
  });
});

describe("order by usage (§23.4)", () => {
  test("siblings by 30-day subtree usage, then last use, then name; default is not pinned", () => {
    const state = initialTopicState(NOW);
    const next = ids();
    const busy = createTopic(state, "Busy", NOW, next);
    const child = createTopic(state, "Parent/Child", NOW, next);
    createTopic(state, "Quiet", NOW, next);
    recordTopicUse(state, busy.id, NOW - 2 * DAY);
    recordTopicUse(state, busy.id, NOW - DAY);
    recordTopicUse(state, child.id, NOW - 3 * DAY);
    recordTopicUse(state, child.id, NOW - 3 * DAY);
    recordTopicUse(state, child.id, NOW); // Parent: 3 via its child
    const views = topicViews(state, noCounts, NOW);
    expect(views.map((view) => view.path)).toEqual([
      "Parent",
      "Parent/Child",
      "Busy",
      "Quiet", // ties with the default at 0 — then by name (Latin sorts before Cyrillic)
      DEFAULT_TOPIC_PATH,
    ]);
    const parent = views.find((view) => view.path === "Parent");
    expect(parent?.usage30d).toBe(3);
    expect(parent?.lastUsedAt).toBe(NOW);
    expect(views.find((view) => view.path === "Parent/Child")?.parentId).toBe(parent?.id ?? "");
  });

  test("use older than 30 days no longer counts and is pruned by day", () => {
    const state = initialTopicState(NOW);
    const old = createTopic(state, "Old", NOW, ids());
    recordTopicUse(state, old.id, NOW - 31 * DAY);
    expect(topicViews(state, noCounts, NOW).find((v) => v.id === old.id)?.usage30d).toBe(0);
    expect(pruneTopicUsage(state, NOW)).toBe(true);
    expect(state.usage[old.id]).toBeUndefined();
  });

  test("counts roll up: direct vs subtree messages", () => {
    const state = initialTopicState(NOW);
    const next = ids();
    const a = createTopic(state, "A", NOW, next);
    const b = createTopic(state, "A/B", NOW, next);
    const counts = new Map<string, TopicCounts>([
      [a.id, { messages: 2, unread: 1 }],
      [b.id, { messages: 3, unread: 0 }],
    ]);
    const view = topicViews(state, counts, NOW).find((v) => v.id === a.id);
    expect(view).toMatchObject({ messageCount: 2, subtreeMessageCount: 5, unread: 1 });
  });
});

describe("sidecar parsing", () => {
  test("junk falls back piece by piece and the default topic is always there", () => {
    expect(parseTopicState("nope", NOW).topics.map((t) => t.id)).toEqual([DEFAULT_TOPIC_ID]);
    const state = parseTopicState(
      {
        topics: [{ id: "x", path: "X", createdAt: 1 }, { id: 7 }],
        labels: { m1: "x", m2: 3 },
        usage: { x: { "1": 2, "2": "bad" } },
        pending: { ids: ["m9", 1] },
      },
      NOW,
    );
    expect(state.topics.map((t) => t.id).sort()).toEqual([DEFAULT_TOPIC_ID, "x"].sort());
    expect(state.labels).toEqual({ m1: "x" });
    expect(state.usage).toEqual({ x: { "1": 2 } });
    expect(state.pending).toEqual({ ids: ["m9"] });
  });
});
