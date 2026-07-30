import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, type Signal, Topology, parseQueueName } from "@teamai/core";
import { dequeue, ensureQueueDirs, queuePaths } from "@teamai/queue";
import { Router } from "../src/router";

const KEYS = new Map([
  ["researcher", "researcher-session"],
  ["writer", "writer-session"],
  ["operator", "operator"],
]);

let root: string;
let router: Router;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "teamai-router-"));
  for (const key of KEYS.values()) await ensureQueueDirs(queuePaths(root, key));
  router = new Router({
    topology: new Topology({ researcher: ["writer", "operator"], writer: ["researcher"] }),
    root,
    queueKeyOf: (name) => KEYS.get(name) ?? null,
    now: () => 1700000000000,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function msg(from: string, to: string, id = "m1"): Message {
  return { id, from, to, kind: "message", ts: 0, payload: "hi" };
}

function pending(key: string): string[] {
  return readdirSync(queuePaths(root, key).pending);
}

describe("router — single delivery point (§8.2, §10.2, §10.11)", () => {
  test("delivers along an edge: enqueues into the recipient's pending/", async () => {
    const result = await router.route(msg("researcher", "writer"));
    expect(result.ok).toBe(true);
    expect(pending("writer-session")).toHaveLength(1);
  });

  test("a non-edge between distinct peers is TOPOLOGY_DENIED and enqueues nothing", async () => {
    const result = await router.route(msg("writer", "operator"));
    expect(result).toEqual({ ok: false, code: "TOPOLOGY_DENIED" });
    expect(pending("operator")).toHaveLength(0);
  });

  test("self-delivery (from == to) is allowed without an edge (§10.2)", async () => {
    const result = await router.route(msg("writer", "writer"));
    expect(result.ok).toBe(true);
    expect(pending("writer-session")).toHaveLength(1);
  });

  test("an unknown recipient is UNKNOWN_PEER", async () => {
    expect(await router.route(msg("researcher", "ghost"))).toEqual({
      ok: false,
      code: "UNKNOWN_PEER",
    });
  });

  test("a malicious id cannot escape pending/, but the logical id is preserved (§10.11)", async () => {
    const result = await router.route(msg("researcher", "writer", "../../etc/passwd"));
    expect(result.ok).toBe(true);
    const files = pending("writer-session");
    expect(files).toHaveLength(1); // landed in pending/, did not escape
    const filename = files[0] ?? "";
    expect(parseQueueName(filename).id).not.toContain("/"); // sanitized filename id
    expect(parseQueueName(filename).id).not.toContain("..");
    const stored = JSON.parse(
      readFileSync(join(queuePaths(root, "writer-session").pending, filename), "utf8"),
    ) as Message;
    expect(stored.id).toBe("../../etc/passwd"); // logical id intact for dedup (§10.9)
  });

  test("seq is monotonic across routes (total order, §5.3)", async () => {
    await router.route(msg("researcher", "writer", "a"));
    await router.route(msg("researcher", "writer", "b"));
    await router.route(msg("researcher", "writer", "c"));
    const seqs = pending("writer-session")
      .map((f) => parseQueueName(f).seq)
      .sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe("router — WIP limit / backpressure (§8.2, FR-104)", () => {
  function gated(wipLimitOf: (name: string) => number | null): Router {
    return new Router({
      topology: new Topology({ researcher: ["writer", "operator"], writer: ["researcher"] }),
      root,
      queueKeyOf: (name) => KEYS.get(name) ?? null,
      wipLimitOf,
      now: () => 1700000000000,
    });
  }

  test("admits up to the limit, then refuses new work with WIP_LIMIT (limit+depth in the receipt)", async () => {
    const r = gated(() => 3);
    for (const id of ["a", "b", "c"]) {
      expect((await r.route(msg("researcher", "writer", id))).ok).toBe(true);
    }
    const refused = await r.route(msg("researcher", "writer", "d"));
    expect(refused).toEqual({ ok: false, code: "WIP_LIMIT", limit: 3, depth: 3 });
    expect(pending("writer-session")).toHaveLength(3); // the 4th did not enqueue
  });

  test("an exempt recipient (null limit) is never gated, however deep its queue", async () => {
    const r = gated(() => null);
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect((await r.route(msg("researcher", "writer", id))).ok).toBe(true);
    }
    expect(pending("writer-session")).toHaveLength(5);
  });

  test("a non-positive limit (0 = unlimited) is treated as exempt", async () => {
    const r = gated(() => 0);
    for (const id of ["a", "b", "c", "d"]) {
      expect((await r.route(msg("researcher", "writer", id))).ok).toBe(true);
    }
    expect(pending("writer-session")).toHaveLength(4);
  });

  test("depth counts the in-flight cur slot, not only pending (depth = pending + cur)", async () => {
    const r = gated(() => 2);
    expect((await r.route(msg("researcher", "writer", "a"))).ok).toBe(true);
    // Claim the message into cur/, so the WIP now lives across cur + pending.
    take(await dequeue(queuePaths(root, "writer-session")));
    expect((await r.route(msg("researcher", "writer", "b"))).ok).toBe(true); // 1 cur + 1 pending = 2
    const refused = await r.route(msg("researcher", "writer", "c"));
    expect(refused).toEqual({ ok: false, code: "WIP_LIMIT", limit: 2, depth: 2 });
  });

  test("gates EVERY kind including replies — the operator chose the hardest bound", async () => {
    const r = gated(() => 1);
    expect((await r.route(msg("researcher", "writer", "a"))).ok).toBe(true);
    const reply: Message = {
      id: "r",
      from: "researcher",
      to: "writer",
      kind: "message",
      ts: 0,
      payload: "re",
      replyTo: "a",
    };
    const refused = await r.route(reply);
    expect(refused).toEqual({ ok: false, code: "WIP_LIMIT", limit: 1, depth: 1 });
  });

  test("the limit is per-recipient: a full writer does not block delivery to the operator", async () => {
    const r = gated((name) => (name === "writer" ? 1 : null));
    expect((await r.route(msg("researcher", "writer", "a"))).ok).toBe(true);
    expect((await r.route(msg("researcher", "writer", "b"))).ok).toBe(false); // writer full
    expect((await r.route(msg("researcher", "operator", "c"))).ok).toBe(true); // operator exempt
  });
});

describe("router — onRefused + bypassWip (§8.2, FR-105)", () => {
  interface Refusal {
    to: string;
    code: string;
    limit?: number | undefined;
    depth?: number | undefined;
  }
  function withRefused(refusals: Refusal[], wipLimitOf?: (name: string) => number | null): Router {
    return new Router({
      topology: new Topology({ researcher: ["writer", "operator"], writer: ["researcher"] }),
      root,
      queueKeyOf: (name) => KEYS.get(name) ?? null,
      ...(wipLimitOf !== undefined ? { wipLimitOf } : {}),
      now: () => 1700000000000,
      onRefused: (message, info) =>
        refusals.push({ to: message.to, code: info.code, limit: info.limit, depth: info.depth }),
    });
  }

  function rendezvous(from: string, to: string, id = "rv1"): Signal {
    return { id, from, to, kind: "rendezvous", ts: 0, payload: "reach out to it" };
  }

  test("onRefused fires with code (+limit/depth) on WIP_LIMIT, not on success", async () => {
    const refusals: Refusal[] = [];
    const r = withRefused(refusals, () => 1);
    expect((await r.route(msg("researcher", "writer", "a"))).ok).toBe(true); // success → no refusal
    await r.route(msg("researcher", "writer", "b")); // full → WIP_LIMIT
    expect(refusals).toEqual([{ to: "writer", code: "WIP_LIMIT", limit: 1, depth: 1 }]);
  });

  test("onRefused fires on TOPOLOGY_DENIED and UNKNOWN_PEER too (code only)", async () => {
    const refusals: Refusal[] = [];
    const r = withRefused(refusals);
    await r.route(msg("writer", "operator")); // no edge
    await r.route(msg("researcher", "ghost")); // unknown
    expect(refusals).toEqual([
      { to: "operator", code: "TOPOLOGY_DENIED", limit: undefined, depth: undefined },
      { to: "ghost", code: "UNKNOWN_PEER", limit: undefined, depth: undefined },
    ]);
  });

  test("bypassWip lets a kind:'rendezvous' notice past a full WIP gate", async () => {
    const refusals: Refusal[] = [];
    const r = withRefused(refusals, () => 1);
    expect((await r.route(msg("researcher", "writer", "a"))).ok).toBe(true); // writer now full (1)
    // an ordinary message is still refused…
    expect((await r.route(msg("researcher", "writer", "b"))).ok).toBe(false);
    // …but the rendezvous notice bypasses the gate and enqueues
    const bypassed = await r.route(rendezvous("researcher", "writer"), { bypassWip: true });
    expect(bypassed.ok).toBe(true);
    expect(pending("writer-session")).toHaveLength(2); // the notice landed past the cap
  });

  test("bypassWip is inert for a non-rendezvous kind — §10.14 stays intact", async () => {
    const r = withRefused([], () => 1);
    expect((await r.route(msg("researcher", "writer", "a"))).ok).toBe(true);
    // bypassWip:true on a plain message must NOT slip past the gate (double guard)
    const refused = await r.route(msg("researcher", "writer", "b"), { bypassWip: true });
    expect(refused).toEqual({ ok: false, code: "WIP_LIMIT", limit: 1, depth: 1 });
  });

  test("a bypassed rendezvous notice still respects topology (§10.2)", async () => {
    const r = withRefused([], () => 1);
    const denied = await r.route(rendezvous("writer", "operator"), { bypassWip: true });
    expect(denied).toEqual({ ok: false, code: "TOPOLOGY_DENIED" });
  });
});

describe("router — broadcast fan-out (§15.4, §10.16, FR-110)", () => {
  // eng = {dev1, dev2}; tag `it` = {dev1, researcher}; `empty` = {} (valid).
  const MEMBERS = new Map([
    ["dev1", "dev1-session"],
    ["dev2", "dev2-session"],
  ]);
  const keyOf = (name: string): string | null => KEYS.get(name) ?? MEMBERS.get(name) ?? null;
  const resolveBroadcast = (to: string): { kind: "group" | "tag"; members: string[] } | null => {
    if (to === "eng") return { kind: "group", members: ["dev1", "dev2"] };
    if (to === "it") return { kind: "tag", members: ["dev1", "researcher"] };
    if (to === "empty") return { kind: "group", members: [] };
    return null;
  };
  async function fanoutRouter(
    opts: {
      wipLimitOf?: (name: string) => number | null;
      routed?: Signal[];
      refused?: { to: string; code: string }[];
    } = {},
  ): Promise<Router> {
    for (const key of MEMBERS.values()) await ensureQueueDirs(queuePaths(root, key));
    return new Router({
      topology: new Topology({
        operator: ["eng", "it", "empty"],
        researcher: ["writer", "operator", "it"],
      }),
      root,
      queueKeyOf: keyOf,
      ...(opts.wipLimitOf !== undefined ? { wipLimitOf: opts.wipLimitOf } : {}),
      now: () => 1700000000000,
      resolveBroadcast,
      ...(opts.routed !== undefined ? { onRouted: (m) => opts.routed?.push(m) } : {}),
      ...(opts.refused !== undefined
        ? { onRefused: (m, i) => opts.refused?.push({ to: m.to, code: i.code }) }
        : {}),
    });
  }
  function bmsg(from: string, to: string, id = "b1"): Message {
    return { id, from, to, kind: "message", ts: 0, payload: "all-hands" };
  }

  test("a group `to` fans out one copy per hierarchical member", async () => {
    const r = await fanoutRouter();
    const result = await r.route(bmsg("operator", "eng"));
    expect(result).toMatchObject({
      ok: true,
      kind: "broadcast",
      target: "eng",
      targetKind: "group",
    });
    expect(pending("dev1-session")).toHaveLength(1);
    expect(pending("dev2-session")).toHaveLength(1);
  });

  test("copies carry kind:'broadcast', a deterministic id, and a broadcast origin (onRouted fires per member)", async () => {
    const routed: Signal[] = [];
    const r = await fanoutRouter({ routed });
    await r.route(bmsg("operator", "eng", "town"));
    expect(routed.map((m) => ({ to: m.to, id: m.id, kind: m.kind, origin: m.origin }))).toEqual([
      { to: "dev1", id: "town:dev1", kind: "broadcast", origin: "broadcast:eng" },
      { to: "dev2", id: "town:dev2", kind: "broadcast", origin: "broadcast:eng" },
    ]);
  });

  test("the sender is excluded from its own fan-out (§15.4)", async () => {
    const r = await fanoutRouter();
    const result = await r.route(bmsg("researcher", "it", "s"));
    expect(result).toMatchObject({ ok: true, kind: "broadcast", targetKind: "tag" });
    expect(pending("dev1-session")).toHaveLength(1);
    expect(pending("researcher-session")).toHaveLength(0); // sender skipped
  });

  test("no edge to the group/tag node denies the WHOLE broadcast (nothing enqueued)", async () => {
    const r = await fanoutRouter();
    const denied = await r.route(bmsg("writer", "eng")); // writer has no edge to eng
    expect(denied).toEqual({ ok: false, code: "TOPOLOGY_DENIED" });
    expect(pending("dev1-session")).toHaveLength(0);
    expect(pending("dev2-session")).toHaveLength(0);
  });

  test("WIP is per-member: a full member is refused in fanout[], others still delivered", async () => {
    const r = await fanoutRouter({ wipLimitOf: (n) => (n === "dev1" ? 1 : null) });
    await r.route(bmsg("operator", "eng", "one")); // dev1:1, dev2:1
    const second = await r.route(bmsg("operator", "eng", "two"));
    expect(second).toMatchObject({
      ok: true,
      kind: "broadcast",
      fanout: [
        { to: "dev1", id: "two:dev1", ok: false, code: "WIP_LIMIT" },
        { to: "dev2", id: "two:dev2", ok: true },
      ],
    });
    expect(pending("dev1-session")).toHaveLength(1); // refused, still 1
    expect(pending("dev2-session")).toHaveLength(2);
  });

  test("a broadcast is one-directional: a per-member WIP strike does NOT fire onRefused (§10.16)", async () => {
    const refused: { to: string; code: string }[] = [];
    const r = await fanoutRouter({ wipLimitOf: (n) => (n === "dev1" ? 1 : null), refused });
    await r.route(bmsg("operator", "eng", "one"));
    await r.route(bmsg("operator", "eng", "two")); // dev1 now over cap
    expect(refused).toEqual([]); // fan-out never registers rendezvous (FR-105 untouched)
  });

  test("an empty group is a valid broadcast with an empty fanout (not an error)", async () => {
    const r = await fanoutRouter();
    const result = await r.route(bmsg("operator", "empty"));
    expect(result).toEqual({
      ok: true,
      kind: "broadcast",
      target: "empty",
      targetKind: "group",
      fanout: [],
    });
  });
});

describe("router — pause gate (§16.2, §10.19, FR-117)", () => {
  function paused(
    isPaused: (name: string) => boolean,
    opts: {
      wipLimitOf?: (name: string) => number | null;
      refused?: { to: string; code: string }[];
    } = {},
  ): Router {
    return new Router({
      topology: new Topology({ researcher: ["writer", "operator"], writer: ["researcher"] }),
      root,
      queueKeyOf: (name) => KEYS.get(name) ?? null,
      isPaused,
      ...(opts.wipLimitOf !== undefined ? { wipLimitOf: opts.wipLimitOf } : {}),
      ...(opts.refused !== undefined
        ? { onRefused: (m, i) => opts.refused?.push({ to: m.to, code: i.code }) }
        : {}),
      now: () => 1700000000000,
    });
  }
  const pausedWriter = (name: string): boolean => name === "writer";

  test("a paused recipient is refused AGENT_PAUSED and NOTHING is enqueued", async () => {
    const r = paused(pausedWriter);
    expect(await r.route(msg("researcher", "writer"))).toEqual({
      ok: false,
      code: "AGENT_PAUSED",
    });
    expect(pending("writer-session")).toHaveLength(0);
  });

  test("only the paused recipient is gated — others deliver normally", async () => {
    const r = paused(pausedWriter);
    expect((await r.route(msg("researcher", "operator", "a"))).ok).toBe(true);
    expect(pending("operator")).toHaveLength(1);
  });

  test("EVERY kind is refused: reply, nudge, rendezvous (even with bypassWip), broadcast copy, raw", async () => {
    const r = paused(pausedWriter);
    const kinds: Signal[] = [
      {
        id: "k1",
        from: "researcher",
        to: "writer",
        kind: "message",
        ts: 0,
        payload: "re",
        replyTo: "x",
      },
      { id: "k2", from: "researcher", to: "writer", kind: "nudge", ts: 0, payload: "answer" },
      {
        id: "k3",
        from: "researcher",
        to: "writer",
        kind: "rendezvous",
        ts: 0,
        payload: "reach out",
      },
      { id: "k4", from: "researcher", to: "writer", kind: "broadcast", ts: 0, payload: "all" },
      {
        id: "k5",
        from: "researcher",
        to: "writer",
        kind: "message",
        ts: 0,
        payload: "ls",
        raw: true,
      },
    ];
    for (const signal of kinds) {
      // bypassWip (FR-105) buys nothing here — it bypasses the WIP gate only (§16.2).
      expect(await r.route(signal, { bypassWip: true })).toEqual({
        ok: false,
        code: "AGENT_PAUSED",
      });
    }
    expect(pending("writer-session")).toHaveLength(0);
  });

  test("self-delivery to a paused agent is refused too — pause is about injection, not rights", async () => {
    const r = paused(pausedWriter);
    expect(await r.route(msg("writer", "writer"))).toEqual({ ok: false, code: "AGENT_PAUSED" });
    expect(pending("writer-session")).toHaveLength(0);
  });

  test("the topology check comes FIRST: a non-neighbour learns TOPOLOGY_DENIED, not the pause", async () => {
    // writer↔operator has no edge; the operator is not paused, the writer is —
    // routing writer→operator must not leak anything about pause state either way.
    const r = paused((name) => name === "operator" || name === "writer");
    expect(await r.route(msg("writer", "operator"))).toEqual({
      ok: false,
      code: "TOPOLOGY_DENIED",
    });
  });

  test("pause comes BEFORE the WIP gate — the receipt names the pause, not the undrained queue", async () => {
    const r = paused(pausedWriter, { wipLimitOf: () => 1 });
    // Fill the queue to its cap first (via an unpaused router), then pause.
    const open = paused(() => false, { wipLimitOf: () => 1 });
    expect((await open.route(msg("researcher", "writer", "a"))).ok).toBe(true);
    expect(await open.route(msg("researcher", "writer", "b"))).toMatchObject({ code: "WIP_LIMIT" });
    expect(await r.route(msg("researcher", "writer", "c"))).toEqual({
      ok: false,
      code: "AGENT_PAUSED",
    });
  });

  test("the refusal does not poison the dedup window: the same id delivers after the resume", async () => {
    const r = paused(pausedWriter);
    expect(await r.route(msg("researcher", "writer", "same"))).toMatchObject({
      code: "AGENT_PAUSED",
    });
    const resumed = paused(() => false);
    expect((await resumed.route(msg("researcher", "writer", "same"))).ok).toBe(true);
    expect(pending("writer-session")).toHaveLength(1);
  });

  test("onRefused reports AGENT_PAUSED (with no limit/depth) — the rendezvous coordinator ignores it", async () => {
    const refused: { to: string; code: string }[] = [];
    const r = paused(pausedWriter, { refused });
    await r.route(msg("researcher", "writer"));
    expect(refused).toEqual([{ to: "writer", code: "AGENT_PAUSED" }]);
  });

  test("a paused member is refused its broadcast copy per-member; the rest are delivered", async () => {
    await ensureQueueDirs(queuePaths(root, "dev1-session"));
    await ensureQueueDirs(queuePaths(root, "dev2-session"));
    const r = new Router({
      topology: new Topology({ operator: ["eng"] }),
      root,
      queueKeyOf: (name) =>
        KEYS.get(name) ??
        (name === "dev1" ? "dev1-session" : name === "dev2" ? "dev2-session" : null),
      isPaused: (name) => name === "dev1",
      resolveBroadcast: (to) =>
        to === "eng" ? { kind: "group", members: ["dev1", "dev2"] } : null,
      now: () => 1700000000000,
    });
    const result = await r.route({
      id: "b",
      from: "operator",
      to: "eng",
      kind: "message",
      ts: 0,
      payload: "all-hands",
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "broadcast",
      fanout: [
        { to: "dev1", id: "b:dev1", ok: false, code: "AGENT_PAUSED" },
        { to: "dev2", id: "b:dev2", ok: true },
      ],
    });
    expect(pending("dev1-session")).toHaveLength(0);
    expect(pending("dev2-session")).toHaveLength(1);
  });
});

function take<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value");
  return value;
}
