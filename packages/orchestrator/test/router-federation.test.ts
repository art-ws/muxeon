// §18.5 (FR-141/FR-142/FR-143) — the router on both sides of a link (§10.26):
// federated egress lands in the link's persistent queue, ingress stamps `from`
// (anti-spoof §10.24), honors the export-grant + owner gates, transits with a
// hop cap, and answers with receipts queued on the same link.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Topology } from "@muxeon/core";
import { readMessage } from "@muxeon/queue";
import {
  type LinkKind,
  type LinkRecord,
  Router,
  type RouterFederation,
  fedQueueRoot,
  isLinkRecord,
} from "../src";
import { ensureSessionQueue } from "../src/session";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-fed-router-"));
  for (const key of ["dev-session", "alex", "sec-session"]) {
    await ensureSessionQueue(root, key);
  }
  for (const link of ["hq", "b", "c"]) {
    await ensureSessionQueue(fedQueueRoot(root), link);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const QUEUE_KEYS: Record<string, string> = {
  dev: "dev-session",
  alex: "alex",
  sec: "sec-session",
};

interface FedOverrides {
  readonly links?: Record<string, LinkKind>;
  readonly transit?: Record<string, boolean>;
  readonly exports?: Record<string, string>;
  readonly correlated?: readonly string[]; // "local remote replyTo" triples
  readonly hopCap?: number;
}

function makeFederation(overrides: FedOverrides = {}): RouterFederation {
  const links: Record<string, LinkKind> = overrides.links ?? { b: "import", hq: "accept" };
  const exports = overrides.exports ?? { dev: "dev" };
  const correlated = new Set(overrides.correlated ?? []);
  return {
    linkKind: (name) => links[name] ?? null,
    transitAllowed: (name) => overrides.transit?.[name] ?? true,
    exportedToLocal: (name) => exports[name] ?? null,
    hasCorrelation: async (local, remote, replyTo) =>
      replyTo !== undefined && correlated.has(`${local} ${remote} ${replyTo}`),
    ...(overrides.hopCap !== undefined ? { hopCap: overrides.hopCap } : {}),
  };
}

function makeRouter(fed: RouterFederation, extra: { paused?: string[]; wip?: number } = {}) {
  const routed: string[] = [];
  const router = new Router({
    topology: new Topology({ alex: ["b"], dev: [] }),
    root,
    queueKeyOf: (name) => QUEUE_KEYS[name] ?? null,
    ...(extra.wip !== undefined ? { wipLimitOf: () => extra.wip ?? null } : {}),
    isPaused: (name) => (extra.paused ?? []).includes(name),
    onRouted: (message) => routed.push(`${message.from}>${message.to}:${message.id}`),
    federation: fed,
  });
  return { router, routed };
}

function pendingOf(dir: string): string[] {
  return readdirSync(join(dir, "pending"));
}

async function readPending(dir: string): Promise<LinkRecord[]> {
  const files = pendingOf(dir).sort();
  const out: LinkRecord[] = [];
  for (const file of files) {
    out.push((await readMessage(join(dir, "pending", file))) as LinkRecord);
  }
  return out;
}

const msg = (over: Partial<LinkRecord> & { to: string }) => ({
  id: "m1",
  from: "alex",
  kind: "message" as const,
  ts: 1,
  payload: "hi",
  ...over,
});

describe("federated egress (§18.5, FR-141)", () => {
  test("an FQN `to` with an edge on the link node lands in the link queue", async () => {
    const { router, routed } = makeRouter(makeFederation());
    const result = await router.route(msg({ to: "dev@b" }));
    expect(result).toMatchObject({ ok: true, key: "b" });
    const [record] = await readPending(join(fedQueueRoot(root), "b"));
    expect(record?.fed).toEqual({ to: "dev", hops: 0 });
    expect(record?.to).toBe("dev@b"); // the queue record keeps the local view
    expect(routed).toEqual(["alex>dev@b:m1"]);
  });

  test("no edge and no correlation → TOPOLOGY_DENIED; correlation opens the reply path", async () => {
    const fed = makeFederation({ correlated: ["dev x@hq r7"] });
    const { router } = makeRouter(fed);
    // dev has no edge on "hq" and this send answers nothing → denied.
    expect(await router.route(msg({ from: "dev", to: "x@hq" }))).toMatchObject({
      ok: false,
      code: "TOPOLOGY_DENIED",
    });
    // The same send as a REPLY to a journaled exchange passes (§18.10-3).
    expect(await router.route(msg({ from: "dev", to: "x@hq", replyTo: "r7" }))).toMatchObject({
      ok: true,
      key: "hq",
    });
  });

  test("an unknown link tail and a degenerate FQN are UNKNOWN_PEER", async () => {
    const { router } = makeRouter(makeFederation());
    expect(await router.route(msg({ to: "dev@nope" }))).toMatchObject({
      ok: false,
      code: "UNKNOWN_PEER",
    });
    expect(await router.route(msg({ to: "@b" }))).toMatchObject({
      ok: false,
      code: "UNKNOWN_PEER",
    });
  });

  test("system kinds never cross the boundary (§18.5)", async () => {
    const { router } = makeRouter(makeFederation());
    expect(await router.route({ ...msg({ to: "dev@b" }), kind: "nudge" })).toMatchObject({
      ok: false,
      code: "TOPOLOGY_DENIED",
    });
  });

  test("without federation ports an FQN stays UNKNOWN_PEER (FR-146)", async () => {
    const router = new Router({
      topology: new Topology({}),
      root,
      queueKeyOf: () => null,
    });
    expect(await router.route(msg({ to: "dev@b" }))).toMatchObject({
      ok: false,
      code: "UNKNOWN_PEER",
    });
  });
});

describe("federated ingress (§18.5, FR-142; §10.24)", () => {
  const inbound = (over: Partial<LinkRecord> = {}): LinkRecord => ({
    id: "r1",
    from: "tl",
    to: "dev@?",
    kind: "message",
    ts: 2,
    payload: "task",
    fed: { to: "dev", hops: 0 },
    ...over,
  });

  test("an exported actor receives; from is stamped by the RECEIVING side", async () => {
    const { router, routed } = makeRouter(makeFederation());
    const result = await router.routeFederatedIngress(inbound(), "hq");
    expect(result).toEqual({ ok: true });
    const [record] = await readPending(join(root, "dev-session"));
    expect(record?.from).toBe("tl@hq"); // §10.24 — the sender cannot forge the suffix
    expect(record?.to).toBe("dev");
    expect(record?.origin).toBe("fed:hq");
    expect(isLinkRecord(record as LinkRecord)).toBe(false); // fed envelope stripped
    // The delivery is journaled locally (feeds reply-correlation §18.10-3)...
    expect(routed).toContain("tl@hq>dev:r1");
    // ...and an ok receipt is queued back on the SAME link (FR-143).
    const receipts = await readPending(join(fedQueueRoot(root), "hq"));
    expect(receipts[0]?.fed.receipt).toEqual({ ref: "r1", code: "ok" });
    expect(receipts[0]?.fed.to).toBe("tl"); // return address: the unstamped from
  });

  test("a non-exported actor does not exist — UNKNOWN_ACTOR receipt (§10.24)", async () => {
    const { router } = makeRouter(makeFederation({ exports: {} }));
    const result = await router.routeFederatedIngress(
      inbound({ fed: { to: "sec", hops: 0 } }),
      "hq",
    );
    expect(result).toEqual({ ok: false, code: "UNKNOWN_ACTOR" });
    expect(pendingOf(join(root, "sec-session"))).toHaveLength(0);
    const receipts = await readPending(join(fedQueueRoot(root), "hq"));
    expect(receipts[0]?.fed.receipt).toMatchObject({ ref: "r1", code: "UNKNOWN_ACTOR" });
  });

  test("reply-correlation reaches a non-exported actor (§18.10-3)", async () => {
    const fed = makeFederation({ exports: {}, correlated: ["sec tl@hq orig-1"] });
    const { router } = makeRouter(fed);
    const result = await router.routeFederatedIngress(
      inbound({ fed: { to: "sec", hops: 0 }, replyTo: "orig-1" }),
      "hq",
    );
    expect(result).toEqual({ ok: true });
    const [record] = await readPending(join(root, "sec-session"));
    expect(record?.to).toBe("sec");
  });

  test("owner gates run at ingress: pause and WIP become receipts (§10.19/§10.14)", async () => {
    const paused = makeRouter(makeFederation(), { paused: ["dev"] });
    expect(await paused.router.routeFederatedIngress(inbound(), "hq")).toEqual({
      ok: false,
      code: "AGENT_PAUSED",
    });
    const gated = makeRouter(makeFederation(), { wip: 0 });
    // wip 0 = exempt → delivered
    expect(await gated.router.routeFederatedIngress(inbound({ id: "r2" }), "hq")).toEqual({
      ok: true,
    });
  });

  test("a WIP-full recipient refuses with limit/depth detail", async () => {
    const { router } = makeRouter(makeFederation(), { wip: 1 });
    expect(await router.routeFederatedIngress(inbound({ id: "w1" }), "hq")).toEqual({ ok: true });
    const result = await router.routeFederatedIngress(inbound({ id: "w2" }), "hq");
    expect(result).toEqual({ ok: false, code: "WIP_LIMIT" });
    const receipts = await readPending(join(fedQueueRoot(root), "hq"));
    const refusal = receipts.find((r) => r.fed.receipt?.ref === "w2");
    expect(refusal?.fed.receipt?.code).toBe("WIP_LIMIT");
  });

  test("system kinds are refused at the boundary (§10.24)", async () => {
    const { router } = makeRouter(makeFederation());
    const result = await router.routeFederatedIngress(
      inbound({ kind: "broadcast" as LinkRecord["kind"] }),
      "hq",
    );
    expect(result).toEqual({ ok: false, code: "UNKNOWN_ACTOR" });
    expect(pendingOf(join(root, "dev-session"))).toHaveLength(0);
  });
});

describe("transit and receipts (§18.5, FR-141/FR-143)", () => {
  test("an FQN head forwards into the next link's queue with hops+1 and a longer from", async () => {
    const fed = makeFederation({ links: { hq: "accept", c: "import" } });
    const { router, routed } = makeRouter(fed);
    const result = await router.routeFederatedIngress(
      {
        id: "t1",
        from: "alex",
        to: "bob@c@?",
        kind: "message",
        ts: 3,
        payload: "x",
        fed: { to: "bob@c", hops: 0 },
      },
      "hq",
    );
    expect(result).toEqual({ ok: true });
    const [record] = await readPending(join(fedQueueRoot(root), "c"));
    expect(record?.from).toBe("alex@hq");
    expect(record?.fed).toEqual({ to: "bob", hops: 1 });
    expect(routed).toEqual([]); // transit is not this server's exchange — no journal
  });

  test("transit toward an import with transit:false is UNKNOWN_ACTOR", async () => {
    const fed = makeFederation({ links: { hq: "accept", c: "import" }, transit: { c: false } });
    const { router } = makeRouter(fed);
    const result = await router.routeFederatedIngress(
      {
        id: "t2",
        from: "a",
        to: "x",
        kind: "message",
        ts: 1,
        payload: null,
        fed: { to: "bob@c", hops: 0 },
      },
      "hq",
    );
    expect(result).toEqual({ ok: false, code: "UNKNOWN_ACTOR" });
  });

  test("the hop cap yields a HOP_CAP receipt, never a loop (FR-141)", async () => {
    const fed = makeFederation({ links: { hq: "accept", c: "import" }, hopCap: 2 });
    const { router } = makeRouter(fed);
    const result = await router.routeFederatedIngress(
      {
        id: "t3",
        from: "a",
        to: "x",
        kind: "message",
        ts: 1,
        payload: null,
        fed: { to: "bob@c", hops: 2 },
      },
      "hq",
    );
    expect(result).toEqual({ ok: false, code: "HOP_CAP" });
    const receipts = await readPending(join(fedQueueRoot(root), "hq"));
    expect(receipts[0]?.fed.receipt).toMatchObject({ ref: "t3", code: "HOP_CAP" });
  });

  test("a failure receipt reaching its origin becomes a [federation] notice to the sender", async () => {
    const { router, routed } = makeRouter(makeFederation());
    const result = await router.routeFederatedIngress(
      {
        id: "m1:receipt",
        from: "dev",
        to: "alex@?",
        kind: "message",
        ts: 4,
        payload: null,
        fed: { to: "alex", hops: 0, receipt: { ref: "m1", code: "WIP_LIMIT", detail: "limit 3" } },
      },
      "b",
    );
    expect(result).toEqual({ ok: true });
    const [notice] = await readPending(join(root, "alex"));
    expect(notice?.from).toBe("dev@b");
    expect(notice?.replyTo).toBe("m1");
    expect(String(notice?.payload)).toContain("WIP_LIMIT");
    expect(routed).toContain("dev@b>alex:m1:fed-receipt");
  });

  test("an ok receipt at its origin is silent", async () => {
    const { router } = makeRouter(makeFederation());
    const result = await router.routeFederatedIngress(
      {
        id: "m1:receipt",
        from: "dev",
        to: "alex@?",
        kind: "message",
        ts: 4,
        payload: null,
        fed: { to: "alex", hops: 0, receipt: { ref: "m1", code: "ok" } },
      },
      "b",
    );
    expect(result).toEqual({ ok: true });
    expect(pendingOf(join(root, "alex"))).toHaveLength(0);
  });

  test("a receipt with an FQN head transits back like an envelope", async () => {
    const fed = makeFederation({ links: { b: "import", hq: "accept" } });
    const { router } = makeRouter(fed);
    const result = await router.routeFederatedIngress(
      {
        id: "x:receipt",
        from: "bob",
        to: "alex@hq@?",
        kind: "message",
        ts: 5,
        payload: null,
        fed: { to: "alex@hq", hops: 0, receipt: { ref: "x", code: "ok" } },
      },
      "b",
    );
    expect(result).toEqual({ ok: true });
    const [record] = await readPending(join(fedQueueRoot(root), "hq"));
    expect(record?.from).toBe("bob@b");
    expect(record?.fed).toMatchObject({ to: "alex", hops: 1 });
    expect(record?.fed.receipt).toEqual({ ref: "x", code: "ok" });
  });
});
