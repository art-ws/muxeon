// §23.2/§23.3 (FR-208…FR-213, FR-216): topics inside HistoryStore — the sidecar
// beside the pair's JSONL, membership by message id, inheritance by replyTo,
// subtree delete with tombstones and crash recovery, per-topic unread.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { HistoryStore } from "../src/history";
import { DEFAULT_TOPIC_ID, TopicError } from "../src/topics";

const ME = "operator-web";
const AGENT = "researcher";
let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-history-topics-"));
  clock = 1_800_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(): HistoryStore {
  let n = 0;
  return new HistoryStore({
    dir,
    operator: ME,
    now: () => clock,
    newId: () => `topic-${++n}`,
  });
}

/** A record at the current clock; the clock then moves on by one tick. */
function out(id: string, extra: Partial<Signal> = {}): Signal {
  clock += 1;
  return { id, from: ME, to: AGENT, kind: "message", ts: clock, payload: id, ...extra };
}

function inb(id: string, extra: Partial<Signal> = {}): Signal {
  clock += 1;
  return { id, from: AGENT, to: ME, kind: "message", ts: clock, payload: id, ...extra };
}

async function ids(history: HistoryStore, topicId?: string): Promise<string[]> {
  const page = await history.page(AGENT, {
    limit: 200,
    ...(topicId !== undefined ? { topicId } : {}),
  });
  return page.records.map((record) => record.id);
}

async function rejects(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    if (error instanceof TopicError) return error.code;
    throw error;
  }
  return undefined;
}

/** Sends `id` into `topicId` the way the connector does: label → append → usage. */
async function send(history: HistoryStore, id: string, topicId: string): Promise<void> {
  await history.assignTopic(AGENT, id, topicId);
  if (await history.append(out(id))) await history.noteTopicSend(AGENT, topicId);
}

describe("membership (§23.1/§23.2)", () => {
  test("a pre-topic log belongs to the default topic without being rewritten", async () => {
    const legacy = [out("m1"), inb("m2")];
    writeFileSync(
      join(dir, `${AGENT}.jsonl`),
      `${legacy.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    const before = readFileSync(join(dir, `${AGENT}.jsonl`), "utf8");
    const history = store();
    expect(await ids(history, DEFAULT_TOPIC_ID)).toEqual(["m1", "m2"]);
    const { topics, defaultId } = await history.topicList(AGENT);
    expect(defaultId).toBe(DEFAULT_TOPIC_ID);
    expect(topics.map((t) => [t.path, t.messageCount])).toEqual([["Общая", 2]]);
    expect(readFileSync(join(dir, `${AGENT}.jsonl`), "utf8")).toBe(before);
    expect(existsSync(join(dir, `${AGENT}.topics.json`))).toBe(false); // nothing mutated yet
  });

  test("a topic feed pages only its own direct records; the full log stays whole", async () => {
    const history = store();
    const release = await history.createTopic(AGENT, "Проект/Релиз");
    await send(history, "a", DEFAULT_TOPIC_ID);
    await send(history, "b", release.id);
    await send(history, "c", release.id);
    expect(await ids(history, release.id)).toEqual(["b", "c"]);
    expect(await ids(history, DEFAULT_TOPIC_ID)).toEqual(["a"]);
    expect(await ids(history)).toEqual(["a", "b", "c"]);
    const parent = (await history.topicList(AGENT)).topics.find((t) => t.path === "Проект");
    expect(await ids(history, parent?.id)).toEqual([]); // direct only — no descendants
  });

  test("an answer with replyTo joins its anchor's topic; without one — the default", async () => {
    const history = store();
    const topic = await history.createTopic(AGENT, "Bugs");
    await send(history, "q", topic.id);
    await history.append(inb("q:reply", { replyTo: "q" }));
    await history.append(inb("spontaneous"));
    await history.append(inb("dangling", { replyTo: "never-existed" }));
    expect(await ids(history, topic.id)).toEqual(["q", "q:reply"]);
    expect(await ids(history, DEFAULT_TOPIC_ID)).toEqual(["spontaneous", "dangling"]);
    expect(history.topicOf(AGENT, "q:reply")).toBe(topic.id);
  });

  test("a send names a topic of THIS pair; the same id never moves to another", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    const b = await history.createTopic(AGENT, "B");
    expect(await rejects(history.assignTopic(AGENT, "x", "nope"))).toBe("TOPIC_NOT_FOUND");
    await send(history, "x", a.id);
    await history.assignTopic(AGENT, "x", a.id); // a retry of the same filing is fine
    expect(await rejects(history.assignTopic(AGENT, "x", b.id))).toBe("MESSAGE_TOPIC_CONFLICT");
    await send(history, "y", DEFAULT_TOPIC_ID);
    expect(await rejects(history.assignTopic(AGENT, "y", a.id))).toBe("MESSAGE_TOPIC_CONFLICT");
    // another pair of the same user has its own tree (§23.1)
    expect(await rejects(history.page("writer", { topicId: a.id }))).toBe("TOPIC_NOT_FOUND");
  });

  test("usage counts new sends only, by subtree", async () => {
    const history = store();
    const leaf = await history.createTopic(AGENT, "P/Leaf");
    await send(history, "s1", leaf.id);
    await send(history, "s1", leaf.id); // the retry: append refuses the duplicate
    await history.append(inb("r1", { replyTo: "s1" })); // answers do not count
    const list = (await history.topicList(AGENT)).topics;
    expect(list.map((t) => [t.path, t.usage30d])).toEqual([
      ["P", 1],
      ["P/Leaf", 1],
      ["Общая", 0],
    ]);
  });
});

describe("delete and clear (§23.3)", () => {
  test("delete removes the subtree and every record in it; tombstones refuse a re-deliver", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    const b = await history.createTopic(AGENT, "A/B");
    await send(history, "keep", DEFAULT_TOPIC_ID);
    await send(history, "a1", a.id);
    await send(history, "b1", b.id);
    await history.append(inb("b1:reply", { replyTo: "b1" }));
    const removal = await history.deleteTopic(AGENT, a.id);
    expect([...removal.topicIds].sort()).toEqual([a.id, b.id].sort());
    expect([...removal.messageIds].sort()).toEqual(["a1", "b1", "b1:reply"]);
    expect(await ids(history)).toEqual(["keep"]);
    expect(await history.append(inb("b1:reply", { replyTo: "b1" }))).toBe(false);
    // a late answer to a removed message is still delivered — into the default
    expect(await history.append(inb("late", { replyTo: "b1" }))).toBe(true);
    expect(await ids(history, DEFAULT_TOPIC_ID)).toEqual(["keep", "late"]);
    // a fresh store reads the same state from disk
    const reread = store();
    expect(await ids(reread)).toEqual(["keep", "late"]);
    expect(await reread.append(inb("a1"))).toBe(false);
    expect(await rejects(reread.deleteTopic(AGENT, DEFAULT_TOPIC_ID))).toBe("DEFAULT_TOPIC");
  });

  test("clear empties the subtree's records but keeps its topics", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    const b = await history.createTopic(AGENT, "A/B");
    await send(history, "a1", a.id);
    await send(history, "b1", b.id);
    await send(history, "d1", DEFAULT_TOPIC_ID);
    const removal = await history.clearTopic(AGENT, a.id);
    expect([...removal.messageIds].sort()).toEqual(["a1", "b1"]);
    expect(await ids(history)).toEqual(["d1"]);
    expect((await history.topicList(AGENT)).topics.map((t) => t.path)).toContain("A/B");
  });

  test("an interrupted delete is finished on the next load (crash intent)", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    await send(history, "a1", a.id);
    await send(history, "d1", DEFAULT_TOPIC_ID);
    // Simulate the crash between step 1 (intent + tombstones) and step 2 (log rewrite).
    const sidecar = join(dir, `${AGENT}.topics.json`);
    const state = JSON.parse(readFileSync(sidecar, "utf8"));
    state.topics = state.topics.filter((t: { id: string }) => t.id !== a.id);
    state.deleted = { a1: clock };
    state.pending = { ids: ["a1"] };
    state.labels.a1 = undefined; // dropped by JSON.stringify
    writeFileSync(sidecar, JSON.stringify(state));
    const reread = store();
    expect(await ids(reread)).toEqual(["d1"]);
    expect(JSON.parse(readFileSync(sidecar, "utf8")).pending).toBeUndefined();
    expect(readFileSync(join(dir, `${AGENT}.jsonl`), "utf8")).not.toContain('"a1"');
  });

  test("Clear chat empties every topic and keeps the tree (§23.1)", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    await send(history, "a1", a.id);
    await history.clear(AGENT);
    expect(await ids(history)).toEqual([]);
    expect((await history.topicList(AGENT)).topics.map((t) => t.path)).toEqual(["A", "Общая"]);
  });
});

describe("unread by topic (§23.3)", () => {
  test("reading a topic leaves the others unread; the pair badge is the sum", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    await send(history, "qa", a.id);
    await send(history, "qd", DEFAULT_TOPIC_ID);
    await history.append(inb("ra", { replyTo: "qa" }));
    await history.append(inb("rd", { replyTo: "qd" }));
    expect(await history.unread(AGENT)).toBe(2);
    await history.markRead(AGENT, a.id);
    expect(await history.unread(AGENT)).toBe(1);
    const list = (await history.topicList(AGENT)).topics;
    expect(list.find((t) => t.id === a.id)?.unread).toBe(0);
    expect(list.find((t) => t.id === DEFAULT_TOPIC_ID)?.unread).toBe(1);
  });

  test("the old pair-wide read still clears every topic (topics off ≡ before §23)", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    await send(history, "qa", a.id);
    await history.append(inb("ra", { replyTo: "qa" }));
    await history.append(inb("rd"));
    await history.markRead(AGENT);
    expect(await history.unread(AGENT)).toBe(0);
    expect(await rejects(history.markRead(AGENT, "nope"))).toBe("TOPIC_NOT_FOUND");
  });
});

describe("retention and export", () => {
  test("a label whose record never came is swept only after its grace", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    await history.append(out("seed")); // a log file, so the sweep visits the pair
    await history.assignTopic(AGENT, "lost", a.id); // route failed: no record follows
    await history.prune();
    const sidecar = (): Record<string, string> =>
      JSON.parse(readFileSync(join(dir, `${AGENT}.topics.json`), "utf8")).labels;
    expect(sidecar().lost).toBe(a.id); // still inside the grace
    clock += 11 * 60 * 1000;
    await history.prune();
    expect(sidecar().lost).toBeUndefined();
  });

  test("the export part carries the tree and non-default membership of live records", async () => {
    const history = store();
    const a = await history.createTopic(AGENT, "A");
    await send(history, "a1", a.id);
    await send(history, "d1", DEFAULT_TOPIC_ID);
    const part = await history.topicExport(AGENT);
    expect(part.defaultId).toBe(DEFAULT_TOPIC_ID);
    expect(part.topics.map((t) => t.path).sort()).toEqual(["A", "Общая"]);
    expect(part.messageTopics).toEqual({ a1: a.id });
  });

  test("the sidecar is never mistaken for a peer log", async () => {
    const history = store();
    await history.createTopic(AGENT, "A");
    await history.append(out("x"));
    expect(readdirSync(dir).some((name) => name.endsWith(".topics.json"))).toBe(true);
    expect(await history.peers()).toEqual([AGENT]);
  });
});
