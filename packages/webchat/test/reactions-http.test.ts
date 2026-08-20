// The panel's reaction surface (§19.5, FR-162) and console-input records
// (§12.9.6, FR-170) over the real connector — the HTTP/WS shapes an operator's
// browser actually sees, including the auth gate (§10.12) and the owner scoping
// (§10.22).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { SESSION_COOKIE, WebchatConnector } from "../src/connector";
import { HistoryStore } from "../src/history";
import type { ConsoleAttachment, ConsoleHandlers } from "../src/ports";
import { type ReactionCatalog, ReactionStore, ReactionUsage, ReactionsHub } from "../src/reactions";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-reactions-http-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CATALOG: ReactionCatalog = {
  categories: [{ name: "feedback", title: "Feedback" }],
  items: [
    { key: "ok", emoji: "👍", label: "Accepted", category: "feedback" },
    { key: "redo", emoji: "🔁", agentMessage: "Redo it.", expectsReply: true },
  ],
  recentLimit: 12,
};

const ports = {
  listPeers: () => ["muxeon"],
  peerStatus: () => "idle" as const,
  peerType: () => "agent" as const,
  queueDepth: async () => 0,
  messagePhase: async () => undefined,
};

function fakeConsolePort() {
  const state = { typed: [] as string[], handlers: undefined as ConsoleHandlers | undefined };
  return {
    state,
    port: {
      actions: () => ({ shutdown: true, reload: true }),
      shutdown: async () => "down" as const,
      reload: async () => "idle" as const,
      commands: () => [],
      runCommand: async () => "",
      console: async (_name: string, handlers: ConsoleHandlers): Promise<ConsoleAttachment> => {
        state.handlers = handlers;
        return {
          cols: 80,
          rows: 24,
          screen: "PRIMED",
          write: (bytes) => state.typed.push(new TextDecoder().decode(bytes)),
          close: () => undefined,
        };
      },
    },
  };
}

interface Harness {
  connector: WebchatConnector;
  history: HistoryStore;
  routed: Signal[];
  token: string;
  console: ReturnType<typeof fakeConsolePort>;
  hub: ReactionsHub;
  request(path: string, init?: RequestInit): Promise<Response>;
}

async function harness(
  options: { catalog?: ReactionCatalog; journal?: readonly Signal[] } = {},
): Promise<Harness> {
  const history = new HistoryStore({
    dir: join(root, "history", "shagin"),
    operator: "shagin",
  });
  const reactionsStore = new ReactionStore({ dir: join(root, "reactions", "shagin") });
  const routed: Signal[] = [];
  // The agent↔agent carrier (§19.13): a fake journal standing in for the transport
  // log, and one sidecar per pair under its own root.
  const journal = options.journal ?? [];
  const pairStores = new Map<string, ReactionStore>();
  const pairStore = (lo: string): ReactionStore => {
    const existing = pairStores.get(lo);
    if (existing !== undefined) return existing;
    const created = new ReactionStore({ dir: join(root, "reactions", "agents", lo) });
    pairStores.set(lo, created);
    return created;
  };
  const hub = new ReactionsHub({
    catalog: options.catalog ?? CATALOG,
    usage: new ReactionUsage({ file: join(root, "reactions-usage.json") }),
    ownerOf: (owner) => (owner === "shagin" ? { history, reactions: reactionsStore } : undefined),
    isAgent: (name) => name === "muxeon" || name === "dev1",
    agentPairs: {
      pair: (a, b) => ({ store: pairStore(a <= b ? a : b), key: a <= b ? b : a }),
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
  });
  const console_ = fakeConsolePort();
  const connector = new WebchatConnector({
    port: 0,
    users: [
      {
        name: "shagin",
        role: "admin",
        password: "hunter2",
        history,
        ports,
        lifecycle: console_.port,
      },
    ],
    reactions: hub,
    transport: {
      page: async () => ({ records: journal }),
      subscribe: () => () => undefined,
    },
  });
  await connector.start(async () => undefined);
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${connector.port}${path}`, init);
  const login = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "shagin", password: "hunter2" }),
  });
  const token = /muxeon_webchat=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return {
    connector,
    history,
    routed,
    token,
    console: console_,
    hub,
    request: (path, init = {}) =>
      request(path, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          cookie: `${SESSION_COOKIE}=${token}`,
        },
      }),
  };
}

const record = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  from: "muxeon",
  to: "shagin",
  kind: "message",
  ts: Date.now(),
  payload: `payload ${id}`,
  ...overrides,
});

describe("GET /api/reactions (§19.5, FR-161/FR-166)", () => {
  test("the catalog and the Recent order are behind the auth gate", async () => {
    const h = await harness();
    try {
      const anonymous = await fetch(`http://127.0.0.1:${h.connector.port}/api/reactions`);
      expect(anonymous.status).toBe(401); // §10.12 — before any route handling
      const response = await h.request("/api/reactions");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: unknown[]; recent: unknown[] };
      expect(body.items).toHaveLength(2);
      expect(body.recent).toEqual([]);
    } finally {
      await h.connector.stop();
    }
  });

  test("no catalog ⇒ 409 REACTIONS_DISABLED on every reaction endpoint (§19.2)", async () => {
    const h = await harness({ catalog: { categories: [], items: [], recentLimit: 12 } });
    try {
      await h.history.append(record("m1"));
      expect((await h.request("/api/reactions")).status).toBe(409);
      const post = await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ok" }),
      });
      expect(post.status).toBe(409);
      expect(((await post.json()) as { code: string }).code).toBe("REACTIONS_DISABLED");
    } finally {
      await h.connector.stop();
    }
  });
});

describe("place / remove (§19.5, FR-162)", () => {
  test("POST places, answers the folded state and reports the notification", async () => {
    const h = await harness();
    try {
      await h.history.append(record("m1"));
      const response = await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ok" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        reactions: { key: string; count: number; mine: boolean; actors: { name: string }[] }[];
        notify: { delivered: boolean };
      };
      expect(body.reactions).toHaveLength(1);
      expect(body.reactions[0]).toMatchObject({ key: "ok", count: 1, mine: true });
      expect(body.reactions[0]?.actors[0]?.name).toBe("shagin");
      expect(body.notify).toEqual({ delivered: true });
      expect(h.routed).toHaveLength(1);
      expect(h.routed[0]?.id).toBe("m1:react:shagin:ok");
    } finally {
      await h.connector.stop();
    }
  });

  test("DELETE removes my own; the second DELETE is an idempotent 200", async () => {
    const h = await harness();
    try {
      await h.history.append(record("m1"));
      await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ok" }),
      });
      const first = await h.request("/api/history/muxeon/messages/m1/reactions/ok", {
        method: "DELETE",
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { reactions: unknown[] }).reactions).toEqual([]);
      expect(
        (await h.request("/api/history/muxeon/messages/m1/reactions/ok", { method: "DELETE" }))
          .status,
      ).toBe(200);
      expect(h.routed).toHaveLength(1); // removal notifies nobody (§19.6)
    } finally {
      await h.connector.stop();
    }
  });

  test("unknown message → 404, unknown key → 400, a missing body key → 400", async () => {
    const h = await harness();
    try {
      await h.history.append(record("m1"));
      const ghost = await h.request("/api/history/muxeon/messages/ghost/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ok" }),
      });
      expect(ghost.status).toBe(404);
      expect(((await ghost.json()) as { code: string }).code).toBe("UNKNOWN_MESSAGE");
      const nope = await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "nope" }),
      });
      expect(nope.status).toBe(400);
      expect(((await nope.json()) as { code: string }).code).toBe("UNKNOWN_REACTION");
      const empty = await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);
    } finally {
      await h.connector.stop();
    }
  });

  test("an unauthenticated placement never reaches the store (§10.12)", async () => {
    const h = await harness();
    try {
      await h.history.append(record("m1"));
      const response = await fetch(
        `http://127.0.0.1:${h.connector.port}/api/history/muxeon/messages/m1/reactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "ok" }),
        },
      );
      expect(response.status).toBe(401);
      expect(h.routed).toEqual([]);
    } finally {
      await h.connector.stop();
    }
  });
});

describe("reactions ride BESIDE the records (§19.5)", () => {
  test("the history page carries a reactions map keyed by message id", async () => {
    const h = await harness();
    try {
      await h.history.append(record("m1"));
      await h.history.append(record("m2"));
      await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ok" }),
      });
      const page = (await (await h.request("/api/history/muxeon")).json()) as {
        records: Signal[];
        reactions: Record<string, { key: string }[]>;
      };
      expect(page.records.map((r) => r.id)).toEqual(["m1", "m2"]);
      expect(Object.keys(page.reactions)).toEqual(["m1"]);
      expect(page.reactions.m1?.[0]?.key).toBe("ok");
      // The envelope itself is untouched — no reactions field inside the record.
      expect(page.records[0]).not.toHaveProperty("reactions");
    } finally {
      await h.connector.stop();
    }
  });

  test("the export gains a reactions field and version 2 (FR-84)", async () => {
    const h = await harness();
    try {
      await h.history.append(record("m1"));
      await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ok" }),
      });
      const body = (await (await h.request("/api/history/muxeon/export")).json()) as {
        version: number;
        records: Signal[];
        reactions: Record<string, unknown[]>;
      };
      expect(body.version).toBe(2);
      expect(body.records).toHaveLength(1);
      expect(body.reactions.m1).toHaveLength(1);
    } finally {
      await h.connector.stop();
    }
  });

  test("clearing the chat drops its reactions too (§19.4)", async () => {
    const h = await harness();
    try {
      await h.history.append(record("m1"));
      await h.request("/api/history/muxeon/messages/m1/reactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ok" }),
      });
      expect((await h.request("/api/history/muxeon/clear", { method: "POST" })).status).toBe(200);
      await h.history.append(record("m1")); // the same id can come back after a clear
      const page = (await (await h.request("/api/history/muxeon")).json()) as {
        reactions?: Record<string, unknown>;
      };
      expect(page.reactions ?? {}).toEqual({});
    } finally {
      await h.connector.stop();
    }
  });
});

describe("console input becomes history (§12.9.6, FR-170)", () => {
  /** Opens a console socket and returns a typing helper. */
  async function typing(h: Harness): Promise<(text: string) => void> {
    const socket = new WebSocket(`ws://127.0.0.1:${h.connector.port}/api/agents/muxeon/console`, {
      headers: { cookie: `${SESSION_COOKIE}=${h.token}` },
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    await Bun.sleep(30); // let the attach finish so writes are not queued
    return (text: string) => socket.send(new TextEncoder().encode(text));
  }

  /** The append is async (a real socket, a real file) — wait for it, don't guess. */
  async function untilRecorded(h: Harness, count: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while ((await h.history.all("muxeon")).length < count) {
      if (Date.now() > deadline) throw new Error("no console record after 3s");
      await Bun.sleep(10);
    }
  }

  test("a submitted line lands in the pair's log with origin:console, unrouted", async () => {
    const h = await harness();
    try {
      const type = await typing(h);
      type("проверь тесты\r");
      await untilRecorded(h, 1);
      const records = await h.history.all("muxeon");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        from: "shagin",
        to: "muxeon",
        kind: "message",
        origin: "console",
        payload: "проверь тесты",
      });
      // The keystrokes still reached the pane — the record is a copy, not a detour.
      expect(h.console.state.typed.join("")).toBe("проверь тесты\r");
      // …and nothing was routed: the console is not a delivery path (§12.9.5).
      expect(h.routed).toEqual([]);
    } finally {
      await h.connector.stop();
    }
  });

  test("an unfinished line records nothing until it is submitted", async () => {
    const h = await harness();
    try {
      const type = await typing(h);
      type("half typed");
      await Bun.sleep(80);
      expect(await h.history.all("muxeon")).toEqual([]);
      type("\r");
      await untilRecorded(h, 1);
      expect((await h.history.all("muxeon"))[0]?.payload).toBe("half typed");
    } finally {
      await h.connector.stop();
    }
  });
});

// §19.13 / FR-182 (decision Q1): the journal is where an operator sees agent↔agent
// traffic, so it is where the receipts have to show up too. Read-only: badges come
// with the page and the push, and nothing places one from here.
describe("reactions on journal rows (§19.13, FR-182)", () => {
  const between = (id: string, from: string, to: string): Signal => ({
    id,
    from,
    to,
    kind: "message",
    ts: 1000,
    payload: `routed ${id}`,
  });

  test("GET /api/transport carries the pair's folded state, never `mine`", async () => {
    const h = await harness({ journal: [between("t1", "dev1", "muxeon")] });
    try {
      await h.hub.react({
        owner: "dev1",
        peer: "muxeon",
        actor: "muxeon",
        messageId: "t1",
        key: "ok",
      });
      const body = (await (await h.request("/api/transport")).json()) as {
        records: Signal[];
        reactions?: Record<string, { key: string; count: number; mine: boolean }[]>;
      };
      expect(body.records.map((record) => record.id)).toEqual(["t1"]);
      expect(body.reactions?.t1).toMatchObject([{ key: "ok", count: 1 }]);
      // The actor was muxeon, but the journal never claims the VIEWER placed it.
      expect(body.reactions?.t1?.[0]?.mine).toBe(false);
    } finally {
      await h.connector.stop();
    }
  });

  test("a user's own pair is NOT enumerated from the journal (§10.31 stays intact)", async () => {
    const h = await harness({ journal: [between("m1", "muxeon", "shagin")] });
    try {
      await h.history.append(record("m1"));
      await h.hub.react({
        owner: "shagin",
        peer: "muxeon",
        actor: "shagin",
        messageId: "m1",
        key: "ok",
      });
      const body = (await (await h.request("/api/transport")).json()) as {
        reactions?: Record<string, unknown>;
      };
      expect(body.reactions ?? {}).toEqual({}); // that badge lives in shagin's chat
    } finally {
      await h.connector.stop();
    }
  });

  test("a live placement pushes `transport-reaction` to the admin's tabs", async () => {
    const h = await harness({ journal: [between("t1", "dev1", "muxeon")] });
    const events: { type: string; messageId?: string }[] = [];
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${h.connector.port}/api/ws`, {
        headers: { cookie: `${SESSION_COOKIE}=${h.token}` },
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String(event.data)) as { type: string; messageId?: string });
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      await h.hub.react({
        owner: "dev1",
        peer: "muxeon",
        actor: "muxeon",
        messageId: "t1",
        key: "ok",
      });
      const deadline = Date.now() + 5000;
      while (!events.some((e) => e.type === "transport-reaction" && e.messageId === "t1")) {
        if (Date.now() > deadline) throw new Error("timeout waiting for the journal push");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      socket.close();
    } finally {
      await h.connector.stop();
    }
  });
});
