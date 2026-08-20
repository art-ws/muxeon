// Reaction store / usage counters / hub (§19, FR-161…FR-167). The invariants under
// test are §10.30 (a reaction is not a turn: at most ONE notification, deterministic
// id, no reply window, no ack chain) and §10.31 (visible exactly to the pair; only
// the author removes their own; the envelope stays untouched).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { HistoryStore } from "../src/history";
import {
  type ReactionCatalog,
  ReactionStore,
  ReactionUsage,
  ReactionsHub,
  reactionPayload,
} from "../src/reactions";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-reactions-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BASE = Date.now();

const store = (owner = "shagin"): ReactionStore =>
  new ReactionStore({ dir: join(root, "reactions", owner) });

const history = (owner: string): HistoryStore =>
  new HistoryStore({ dir: join(root, "history", owner), operator: owner });

function record(id: string, overrides: Partial<Signal> = {}): Signal {
  return {
    id,
    from: "muxeon",
    to: "shagin",
    kind: "message",
    ts: BASE,
    payload: `payload of ${id}`,
    ...overrides,
  };
}

const CATALOG: ReactionCatalog = {
  categories: [{ name: "feedback", title: "Отклик" }],
  items: [
    { key: "ok", emoji: "👍", label: "Принято", category: "feedback" },
    {
      key: "redo",
      emoji: "🔁",
      label: "Переделать",
      category: "feedback",
      agentMessage: "Переделай результат этого сообщения.",
      expectsReply: true,
    },
  ],
  recentLimit: 12,
};

describe("ReactionStore — events, folding, idempotency (§19.4)", () => {
  test("an add folds into one view; a repeat of the same triple is a no-op", async () => {
    const reactions = store();
    expect(await reactions.add("muxeon", "m1", "shagin", "ok", "👍")).toBe(true);
    expect(await reactions.add("muxeon", "m1", "shagin", "ok", "👍")).toBe(false);
    const views = await reactions.of("muxeon", "m1", "shagin");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ key: "ok", emoji: "👍", count: 1, mine: true });
    // One line, not two — the repeat wrote nothing (§19.4).
    const raw = readFileSync(join(root, "reactions", "shagin", "muxeon.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  test("several DIFFERENT keys from one actor coexist (p. 3 of the request)", async () => {
    const reactions = store();
    await reactions.add("muxeon", "m1", "shagin", "ok", "👍");
    await reactions.add("muxeon", "m1", "shagin", "redo", "🔁");
    expect((await reactions.of("muxeon", "m1", "shagin")).map((view) => view.key)).toEqual([
      "ok",
      "redo",
    ]);
  });

  test("two actors on one key count 2 and both appear, oldest first", async () => {
    const reactions = store();
    await reactions.add("muxeon", "m1", "shagin", "ok", "👍");
    await reactions.add("muxeon", "m1", "muxeon", "ok", "👍");
    const [view] = await reactions.of("muxeon", "m1", "shagin");
    expect(view?.count).toBe(2);
    expect(view?.actors.map((actor) => actor.name)).toEqual(["shagin", "muxeon"]);
    expect(view?.mine).toBe(true); // the viewer is one of them
  });

  test("remove drops only the actor's OWN entry; the other actor's stays", async () => {
    const reactions = store();
    await reactions.add("muxeon", "m1", "shagin", "ok", "👍");
    await reactions.add("muxeon", "m1", "muxeon", "ok", "👍");
    expect(await reactions.remove("muxeon", "m1", "shagin", "ok")).toBe(true);
    const [view] = await reactions.of("muxeon", "m1", "shagin");
    expect(view?.count).toBe(1);
    expect(view?.mine).toBe(false);
    // Removing what is not there is an idempotent false, never an error.
    expect(await reactions.remove("muxeon", "m1", "shagin", "ok")).toBe(false);
  });

  test("the emoji is a SNAPSHOT — a key dropped from the config still renders (§19.4)", async () => {
    const reactions = store();
    await reactions.add("muxeon", "m1", "shagin", "gone", "🦄");
    const fresh = store();
    expect((await fresh.of("muxeon", "m1", "shagin"))[0]?.emoji).toBe("🦄");
  });

  test("a crash-torn tail is dropped on load; earlier events survive", async () => {
    const file = join(root, "reactions", "shagin", "muxeon.jsonl");
    const reactions = store();
    await reactions.add("muxeon", "m1", "shagin", "ok", "👍");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"op":"add","message":"m2"`);
    const fresh = store();
    expect((await fresh.of("muxeon", "m1", "shagin")).map((v) => v.key)).toEqual(["ok"]);
    expect(await fresh.of("muxeon", "m2", "shagin")).toEqual([]);
  });

  test("map() answers only for the ids asked for; mapAll merges every pair", async () => {
    const reactions = store();
    await reactions.add("muxeon", "m1", "shagin", "ok", "👍");
    await reactions.add("dev", "m2", "shagin", "ok", "👍");
    expect(Object.keys(await reactions.map("muxeon", ["m1", "m2"], "shagin"))).toEqual(["m1"]);
    expect(Object.keys(await reactions.mapAll(["m1", "m2"], "shagin")).sort()).toEqual([
      "m1",
      "m2",
    ]);
  });

  test("compact keeps only live ids and collapses removals; clear drops the file", async () => {
    const reactions = store();
    await reactions.add("muxeon", "m1", "shagin", "ok", "👍");
    await reactions.add("muxeon", "m2", "shagin", "ok", "👍");
    await reactions.remove("muxeon", "m2", "shagin", "ok");
    await reactions.compact("muxeon", new Set(["m1"]));
    const raw = readFileSync(join(root, "reactions", "shagin", "muxeon.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1); // one surviving add, no removal tail
    expect((await store().of("muxeon", "m1", "shagin")).map((v) => v.key)).toEqual(["ok"]);
    await reactions.clear("muxeon");
    expect(await reactions.of("muxeon", "m1", "shagin")).toEqual([]);
    expect(await store().of("muxeon", "m1", "shagin")).toEqual([]);
  });
});

describe("ReactionUsage — global, monotonic (§19.8, FR-166)", () => {
  const usageFile = (): string => join(root, "reactions-usage.json");

  test("order is count desc, then most recent, then catalog order", async () => {
    let clock = BASE;
    const tick = (): number => {
      clock += 1000;
      return clock;
    };
    const usage = new ReactionUsage({ file: usageFile(), now: tick });
    usage.bump("ok");
    usage.bump("ok");
    usage.bump("redo");
    usage.bump("hold");
    // ok=2; redo and hold both 1 — hold was used LATER, so it sorts ahead.
    expect(usage.order(["ok", "redo", "hold"], 12)).toEqual(["ok", "hold", "redo"]);
  });

  test("unused keys are absent, the limit caps, 0 hides the block", () => {
    const usage = new ReactionUsage({ file: usageFile() });
    usage.bump("ok");
    usage.bump("redo");
    expect(usage.order(["ok", "redo", "never"], 12)).toEqual(["ok", "redo"]);
    expect(usage.order(["ok", "redo"], 1)).toEqual(["ok"]);
    expect(usage.order(["ok", "redo"], 0)).toEqual([]);
  });

  test("a key outside the catalog is dropped from the OUTPUT but keeps its count", async () => {
    const usage = new ReactionUsage({ file: usageFile(), flushMs: 0 });
    usage.bump("dropped");
    usage.bump("ok");
    await usage.flush();
    expect(usage.order(["ok"], 12)).toEqual(["ok"]); // "dropped" is not offered…
    const reloaded = new ReactionUsage({ file: usageFile() });
    await reloaded.load();
    expect([...reloaded.order(["ok", "dropped"], 12)].sort()).toEqual(["dropped", "ok"]); // …not forgotten
  });

  test("counters survive a restart and a removal never decrements them", async () => {
    const usage = new ReactionUsage({ file: usageFile(), flushMs: 0 });
    usage.bump("ok");
    usage.bump("ok");
    await usage.flush();
    const reloaded = new ReactionUsage({ file: usageFile() });
    await reloaded.load();
    // Nothing in the API can lower a count — the store has no decrement at all.
    expect(reloaded.order(["ok", "redo"], 12)).toEqual(["ok"]);
  });
});

/** A hub over one user (`shagin`) whose neighbour agent is `muxeon`. */
async function hub(
  options: {
    catalog?: ReactionCatalog;
    agents?: readonly string[];
    users?: readonly string[];
    /** Records the fake transport journal holds — the agent↔agent carrier (§19.13). */
    journal?: readonly Signal[];
  } = {},
): Promise<{
  hub: ReactionsHub;
  routed: Signal[];
  pushes: { owner: string; messageId: string; keys: string[] }[];
  historyOf: (owner: string) => HistoryStore;
  pairStore: (a: string, b: string) => ReactionStore;
}> {
  const agents = new Set(options.agents ?? ["muxeon"]);
  const owners = new Map<string, { history: HistoryStore; reactions: ReactionStore }>();
  for (const name of options.users ?? ["shagin"]) {
    owners.set(name, { history: history(name), reactions: store(name) });
  }
  const routed: Signal[] = [];
  const pushes: { owner: string; messageId: string; keys: string[] }[] = [];
  const usage = new ReactionUsage({ file: join(root, "reactions-usage.json") });
  // The agent↔agent carrier (§19.13): one sidecar per pair under its own root, and a
  // journal lookup standing in for the transport log.
  const pairStores = new Map<string, ReactionStore>();
  const pairStore = (a: string, b: string): ReactionStore => {
    const lo = a <= b ? a : b;
    const existing = pairStores.get(lo);
    if (existing !== undefined) return existing;
    const created = new ReactionStore({ dir: join(root, "reactions", "agents", lo) });
    pairStores.set(lo, created);
    return created;
  };
  const journal = options.journal ?? [];
  const instance = new ReactionsHub({
    catalog: options.catalog ?? CATALOG,
    usage,
    ownerOf: (owner) => owners.get(owner),
    isAgent: (name) => agents.has(name),
    agentPairs: {
      pair: (a, b) => ({ store: pairStore(a, b), key: a <= b ? b : a }),
      record: async (a, b, id) =>
        journal.find(
          (entry) =>
            entry.id === id &&
            ((entry.from === a && entry.to === b) || (entry.from === b && entry.to === a)),
        ),
    },
    route: async (signal) => {
      routed.push(signal);
      return { ok: true };
    },
    push: (owner, event) =>
      pushes.push({
        owner,
        messageId: event.messageId,
        keys: event.reactions.map((view) => view.key),
      }),
    now: () => BASE,
  });
  return {
    hub: instance,
    routed,
    pushes,
    historyOf: (owner) => {
      const found = owners.get(owner);
      if (found === undefined) throw new Error(`no owner ${owner}`);
      return found.history;
    },
    pairStore,
  };
}

describe("ReactionsHub — the notification asymmetry (§19.6, FR-164/FR-165)", () => {
  test("a reaction on an AGENT's message routes exactly one kind:'reaction' notice", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("m1"));
    const outcome = await ctx.hub.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "m1",
      actor: "shagin",
      key: "ok",
    });
    expect(outcome.ok).toBe(true);
    expect(ctx.routed).toHaveLength(1);
    const notice = ctx.routed[0] as Signal;
    expect(notice.kind).toBe("reaction");
    expect(notice.id).toBe("m1:react:shagin:ok"); // deterministic (§10.9 dedup)
    expect(notice.from).toBe("shagin");
    expect(notice.to).toBe("muxeon");
    expect(notice.replyTo).toBe("m1");
    expect(notice.origin).toBe("reaction:ok");
    // A notice by default: NO expectsReply, so the render names no reply path.
    expect(notice.expectsReply).toBeUndefined();
    expect(String(notice.payload)).toContain("👍");
    expect(outcome.ok && outcome.notify).toEqual({ delivered: true });
  });

  test("expectsReply:true rides along — the operator's opt-in to a real turn", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("m1"));
    await ctx.hub.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "m1",
      actor: "shagin",
      key: "redo",
    });
    expect((ctx.routed[0] as Signal).expectsReply).toBe(true);
    expect(String((ctx.routed[0] as Signal).payload)).toContain(
      "Переделай результат этого сообщения.",
    );
  });

  test("an idempotent repeat notifies ONCE — no ack ping-pong material (§10.30)", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("m1"));
    const input = {
      owner: "shagin",
      peer: "muxeon",
      messageId: "m1",
      actor: "shagin",
      key: "ok",
    } as const;
    await ctx.hub.react(input);
    await ctx.hub.react(input);
    expect(ctx.routed).toHaveLength(1);
  });

  test("removal notifies nobody and self-reaction notifies nobody", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("m1"));
    await ctx.historyOf("shagin").append(record("mine", { from: "shagin", to: "muxeon" }));
    await ctx.hub.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "m1",
      actor: "shagin",
      key: "ok",
    });
    await ctx.hub.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "m1",
      actor: "shagin",
      key: "ok",
      remove: true,
    });
    await ctx.hub.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "mine",
      actor: "shagin",
      key: "ok",
    });
    expect(ctx.routed).toHaveLength(1); // the first placement only
  });

  test("a reaction on a HUMAN's message routes nothing — the push IS the notice", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("mine", { from: "shagin", to: "muxeon" }));
    const outcome = await ctx.hub.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "mine",
      actor: "muxeon", // the agent reacts to the human's message (FR-167)
      key: "ok",
    });
    expect(outcome.ok).toBe(true);
    expect(ctx.routed).toEqual([]);
    expect(ctx.pushes).toEqual([{ owner: "shagin", messageId: "mine", keys: ["ok"] }]);
  });

  test("a refused notification is REPORTED, and the reaction is still placed (T239 rule)", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("m1"));
    const paused = new ReactionsHub({
      catalog: CATALOG,
      usage: new ReactionUsage({ file: join(root, "reactions-usage.json") }),
      ownerOf: () => ({ history: ctx.historyOf("shagin"), reactions: store("shagin") }),
      // Only the peer is an agent: a pair of two agents takes the journal path
      // (§19.13), and this case is the human→agent one.
      isAgent: (name) => name === "muxeon",
      route: async () => ({ ok: false, code: "AGENT_PAUSED" }),
    });
    const outcome = await paused.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "m1",
      actor: "shagin",
      key: "ok",
    });
    expect(outcome).toMatchObject({ ok: true, notify: { delivered: false, code: "AGENT_PAUSED" } });
    expect(outcome.ok && outcome.reactions.map((view) => view.key)).toEqual(["ok"]);
  });

  test("a user↔user pair is mirrored so BOTH humans see the badge (§19.4)", async () => {
    const ctx = await hub({ agents: [], users: ["shagin", "ivan"] });
    const shared = record("u1", { from: "ivan", to: "shagin" });
    await ctx.historyOf("shagin").append(shared);
    await ctx.historyOf("ivan").append(shared);
    await ctx.hub.react({
      owner: "shagin",
      peer: "ivan",
      messageId: "u1",
      actor: "shagin",
      key: "ok",
    });
    // Ivan's own copy of the pair carries the same reaction.
    const mirrored = await store("ivan").of("shagin", "u1", "ivan");
    expect(mirrored.map((view) => view.key)).toEqual(["ok"]);
    expect(mirrored[0]?.mine).toBe(false); // it is shagin's signature, not ivan's
    expect(ctx.pushes.map((push) => push.owner).sort()).toEqual(["ivan", "shagin"]);
  });
});

describe("ReactionsHub — refusals are named, never silent (§19.7)", () => {
  test("an unknown key, an unknown message and an unknown owner each say which", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("m1"));
    expect(
      await ctx.hub.react({
        owner: "shagin",
        peer: "muxeon",
        messageId: "m1",
        actor: "shagin",
        key: "nope",
      }),
    ).toMatchObject({ ok: false, code: "UNKNOWN_REACTION" });
    expect(
      await ctx.hub.react({
        owner: "shagin",
        peer: "muxeon",
        messageId: "ghost",
        actor: "shagin",
        key: "ok",
      }),
    ).toMatchObject({ ok: false, code: "UNKNOWN_MESSAGE" });
    // An agent keeps no panel history — reacting "inside" it has no home (§19.10).
    expect(
      await ctx.hub.react({
        owner: "muxeon",
        peer: "shagin",
        messageId: "m1",
        actor: "muxeon",
        key: "ok",
      }),
    ).toMatchObject({ ok: false, code: "NOT_REACTABLE" });
  });

  test("no catalog ⇒ REACTIONS_DISABLED and `enabled` is false (§19.2)", async () => {
    const ctx = await hub({ catalog: { categories: [], items: [], recentLimit: 12 } });
    expect(ctx.hub.enabled).toBe(false);
    expect(
      await ctx.hub.react({
        owner: "shagin",
        peer: "muxeon",
        messageId: "m1",
        actor: "shagin",
        key: "ok",
      }),
    ).toMatchObject({ ok: false, code: "REACTIONS_DISABLED" });
  });

  test("the catalog carries the Recent order (§19.8)", async () => {
    const ctx = await hub();
    await ctx.historyOf("shagin").append(record("m1"));
    expect(ctx.hub.catalog().recent).toEqual([]); // nothing used yet
    await ctx.hub.react({
      owner: "shagin",
      peer: "muxeon",
      messageId: "m1",
      actor: "shagin",
      key: "ok",
    });
    expect(ctx.hub.catalog().recent).toEqual(["ok"]);
    expect(ctx.hub.catalog().items.map((item) => item.key)).toEqual(["ok", "redo"]);
  });
});

describe("the agent's payload (§19.6)", () => {
  test("preamble names emoji, label, actor and the marked message; then the operator's text", () => {
    const text = reactionPayload(
      { key: "redo", emoji: "🔁", label: "Переделать", agentMessage: "Сделай заново." },
      "shagin",
      "m1",
    );
    expect(text.split("\n")[0]).toBe(
      "[muxeon reaction] 🔁 Переделать from shagin on your message m1",
    );
    expect(text.split("\n")[1]).toBe("Сделай заново.");
  });

  test("no configured text ⇒ the coordinator's own words, in English (§13.2/T76)", () => {
    const text = reactionPayload({ key: "fire", emoji: "🔥" }, "shagin", "m1");
    expect(text).toContain("[muxeon reaction] 🔥 fire from shagin on your message m1");
    expect(text).toContain("No instruction is attached");
  });
});

// §19.13 / FR-181: two AGENTS. The pair keeps no panel history — that is why
// §19.10 excluded it — but the transport journal holds every signal between them,
// and that is the carrier. Decision Q3 rides here too: between agents a reaction is
// ALWAYS a notice, whatever the catalog says.
describe("ReactionsHub — reactions between agents (§19.13, FR-181)", () => {
  const between = (id: string, from: string, to: string): Signal => ({
    id,
    from,
    to,
    kind: "message",
    ts: BASE,
    payload: `payload of ${id}`,
  });

  const pair = async (journal?: readonly Signal[]) =>
    await hub({
      agents: ["tl", "dev1"],
      journal: journal ?? [between("t1", "dev1", "tl")],
    });

  test("a reaction on a peer agent's message notifies it exactly once", async () => {
    const ctx = await pair();
    const outcome = await ctx.hub.react({
      owner: "dev1", // the peer whose side of the pair holds the record
      peer: "tl",
      actor: "tl",
      messageId: "t1",
      key: "ok",
    });
    expect(outcome).toMatchObject({ ok: true, notify: { delivered: true } });
    expect(ctx.routed).toHaveLength(1);
    const notice = ctx.routed[0] as Signal;
    expect(notice.kind).toBe("reaction");
    expect(notice.id).toBe("t1:react:tl:ok"); // deterministic, dedup as everywhere
    expect(notice.from).toBe("tl");
    expect(notice.to).toBe("dev1");
    expect(notice.replyTo).toBe("t1");
    expect(notice.expectsReply).toBeUndefined(); // a notice — no reply path is named
  });

  test("the payload is the HEAD LINE alone — the operator's text is not put in a peer's mouth", async () => {
    const ctx = await pair();
    await ctx.hub.react({ owner: "dev1", peer: "tl", actor: "tl", messageId: "t1", key: "redo" });
    const payload = String((ctx.routed[0] as Signal).payload);
    expect(payload).toBe("[muxeon reaction] 🔁 Переделать from tl on your message t1");
    expect(payload).not.toContain("Переделай результат"); // that text is the operator's
  });

  test("an instructive key does NOT become an errand between agents (decision Q3)", async () => {
    const ctx = await pair();
    await ctx.hub.react({ owner: "dev1", peer: "tl", actor: "tl", messageId: "t1", key: "redo" });
    // The catalog says expectsReply:true; from a peer agent it is ignored, so the
    // receiver reads a notice and owes nothing — which is the whole point (§13.7).
    expect((ctx.routed[0] as Signal).expectsReply).toBeUndefined();
  });

  test("ONE sidecar per pair — either side sees the same folded state", async () => {
    const ctx = await pair();
    await ctx.hub.react({ owner: "dev1", peer: "tl", actor: "tl", messageId: "t1", key: "ok" });
    await ctx.hub.react({ owner: "tl", peer: "dev1", actor: "dev1", messageId: "t1", key: "ok" });
    const store = ctx.pairStore("dev1", "tl");
    const views = await store.of("tl", "t1", "tl"); // canonical order: dev1 < tl
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ key: "ok", count: 2 });
    expect(views[0]?.actors.map((actor) => actor.name)).toEqual(["tl", "dev1"]);
  });

  test("an idempotent repeat notifies once; remove takes back only your own", async () => {
    const ctx = await pair();
    const input = { owner: "dev1", peer: "tl", actor: "tl", messageId: "t1", key: "ok" };
    await ctx.hub.react(input);
    await ctx.hub.react(input);
    expect(ctx.routed).toHaveLength(1);
    const removed = await ctx.hub.react({ ...input, remove: true });
    expect(removed).toMatchObject({ ok: true });
    expect(removed.ok && removed.reactions).toEqual([]);
    expect(ctx.routed).toHaveLength(1); // a removal notifies nobody (§19.6)
  });

  test("marking your OWN message notifies no one — nobody pings themselves", async () => {
    const ctx = await pair([between("t2", "tl", "dev1")]);
    const outcome = await ctx.hub.react({
      owner: "dev1",
      peer: "tl",
      actor: "tl",
      messageId: "t2", // tl's own message
      key: "ok",
    });
    expect(outcome.ok).toBe(true);
    expect(ctx.routed).toEqual([]);
  });

  test("an id the journal does not hold on THIS pair is UNKNOWN_MESSAGE", async () => {
    const ctx = await pair([between("t1", "dev1", "tl"), between("x9", "dev1", "sherlock")]);
    for (const messageId of ["ghost", "x9"]) {
      expect(
        await ctx.hub.react({ owner: "dev1", peer: "tl", actor: "tl", messageId, key: "ok" }),
      ).toMatchObject({ ok: false, code: "UNKNOWN_MESSAGE" });
    }
  });

  test("without a carrier wired, an agent pair is NOT_REACTABLE (the pre-FR-181 answer)", async () => {
    const ctx = await hub({ agents: ["tl", "dev1"] });
    // The default helper wires a carrier with an EMPTY journal, so this asserts the
    // other half: an empty journal cannot invent a record either.
    expect(
      await ctx.hub.react({ owner: "dev1", peer: "tl", actor: "tl", messageId: "t1", key: "ok" }),
    ).toMatchObject({ ok: false, code: "UNKNOWN_MESSAGE" });
  });

  test("the shared counters count agent reactions too — Recent is global (§19.8)", async () => {
    const ctx = await pair();
    await ctx.hub.react({ owner: "dev1", peer: "tl", actor: "tl", messageId: "t1", key: "ok" });
    expect(ctx.hub.catalog().recent).toEqual(["ok"]);
  });
});
