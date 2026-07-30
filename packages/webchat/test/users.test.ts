// Webchat in users mode (§17.4/§17.7, FR-127/FR-128/FR-131) and the isolation
// invariant §10.22: an authenticated session gets the capability set of ITS user
// and nothing else — another user's history, peers, unread and blobs are not
// merely forbidden but structurally unreachable (they live behind that user's own
// objects). Plus: self-chat, the admin-only transport journal, and DND.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Signal } from "@teamai/core";
import { WebchatConnector, type WebchatUserOptions } from "../src/connector";
import { HistoryStore } from "../src/history";
import type { WebchatPorts } from "../src/ports";

let dir: string;
let inbound: Message[];
let connector: WebchatConnector;
let paused: Set<string>;
/** The very stores the connector serves from — the test seeds through them. */
let histories: Map<string, HistoryStore>;

const ports = (owner: string): WebchatPorts => ({
  listPeers: () => (owner === "alex" ? ["dev", "kim"] : ["dev"]),
  peerStatus: (name) => (name === "dev" ? "idle" : undefined),
  peerType: (name) => (name === "kim" || name === "alex" ? "user" : "agent"),
  peerPresence: (name) => (name === "kim" ? "online" : "offline"),
  peerPaused: (name) => paused.has(name),
  queueDepth: async () => 0,
  messagePhase: async () => undefined,
});

function user(name: string, extra: Partial<WebchatUserOptions> = {}): WebchatUserOptions {
  const history = new HistoryStore({ dir: join(dir, name), operator: name });
  histories.set(name, history);
  return {
    name,
    role: name === "alex" ? "admin" : "user",
    password: `${name}-pw`,
    history,
    ports: ports(name),
    lifecycle: {
      actions: () => ({ shutdown: false, reload: false, pause: true }),
      shutdown: async () => "down",
      reload: async () => "idle",
      pause: async (target, want) => {
        if (want) paused.add(target);
        else paused.delete(target);
        return paused.has(target);
      },
      commands: () => [],
      runCommand: async () => "",
    },
    ...extra,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "teamai-webchat-users-"));
  inbound = [];
  paused = new Set();
  histories = new Map();
  connector = new WebchatConnector({
    port: 0,
    users: [user("alex"), user("kim")],
    transport: { page: async () => ({ records: [] }), subscribe: () => () => undefined },
  });
  await connector.start(async (message) => {
    inbound.push(message);
  });
});

afterEach(async () => {
  await connector.stop();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, cookie?: string): Request =>
  new Request(`http://panel.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "panel.test",
      ...(cookie !== undefined ? { cookie: `teamai_webchat=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (path: string, cookie?: string): Request =>
  new Request(`http://panel.test${path}`, {
    headers: {
      host: "panel.test",
      ...(cookie !== undefined ? { cookie: `teamai_webchat=${cookie}` } : {}),
    },
  });

async function login(name: string, password = `${name}-pw`): Promise<string> {
  const response = await connector.handleRequest(post("/api/login", { user: name, password }));
  expect(response.status).toBe(200);
  const token = /teamai_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (token === undefined) throw new Error("no session cookie issued");
  return token;
}

describe("login in users mode (§17.4, FR-122/FR-127)", () => {
  test("each user logs in with their OWN password", async () => {
    expect(
      (await connector.handleRequest(post("/api/login", { user: "alex", password: "alex-pw" })))
        .status,
    ).toBe(200);
    expect(
      (await connector.handleRequest(post("/api/login", { user: "kim", password: "alex-pw" })))
        .status,
    ).toBe(401);
  });

  test("a missing user is a 400 — the panel must say who is logging in", async () => {
    const response = await connector.handleRequest(post("/api/login", { password: "alex-pw" }));
    expect(response.status).toBe(400);
  });

  test("an unknown user and a wrong password are indistinguishable (§8.7)", async () => {
    const unknown = await connector.handleRequest(
      post("/api/login", { user: "nope", password: "x" }),
    );
    const wrong = await connector.handleRequest(
      post("/api/login", { user: "alex", password: "x" }),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  test("a passwordHash user logs in with the plaintext behind it (FR-122)", async () => {
    const hash = await Bun.password.hash("s3cret", { algorithm: "argon2id" });
    const { password: _literal, ...zoe } = user("zoe");
    const withHash = new WebchatConnector({ port: 0, users: [{ ...zoe, passwordHash: hash }] });
    await withHash.start(async () => undefined);
    expect(
      (await withHash.handleRequest(post("/api/login", { user: "zoe", password: "s3cret" })))
        .status,
    ).toBe(200);
    expect(
      (await withHash.handleRequest(post("/api/login", { user: "zoe", password: "wrong" }))).status,
    ).toBe(401);
    await withHash.stop();
  });

  test("the session reports WHO is logged in and their role (FR-131)", async () => {
    const token = await login("kim");
    const body = (await (await connector.handleRequest(get("/api/session", token))).json()) as {
      user: string;
      role: string;
      selfChat: boolean;
    };
    expect(body.user).toBe("kim");
    expect(body.role).toBe("user");
    expect(body.selfChat).toBe(true);
  });
});

describe("per-user isolation (§10.22, FR-127)", () => {
  test("a send is attributed to the LOGGED-IN user, never to a claimed name", async () => {
    const token = await login("kim");
    await connector.handleRequest(
      post("/api/send", { to: "dev", id: "m1", text: "hi", from: "alex" }, token),
    );
    expect(inbound[0]?.from).toBe("kim");
  });

  test("each user sees only their OWN peers (§10.2)", async () => {
    const alex = (await (
      await connector.handleRequest(get("/api/peers", await login("alex")))
    ).json()) as { peers: { name: string }[] };
    const kim = (await (
      await connector.handleRequest(get("/api/peers", await login("kim")))
    ).json()) as { peers: { name: string }[] };
    expect(alex.peers.map((p) => p.name)).toEqual(["dev", "kim"]);
    expect(kim.peers.map((p) => p.name)).toEqual(["dev"]);
  });

  test("one user's history is unreachable from another's session", async () => {
    const record: Signal = {
      id: "h1",
      from: "dev",
      to: "alex",
      kind: "message",
      ts: 1,
      payload: "for alex only",
    };
    const alexToken = await login("alex");
    const kimToken = await login("kim");
    // deliver into alex's own store (the pseudo-session sink does this in prod)
    await histories.get("alex")?.append(record);

    const asAlex = (await (
      await connector.handleRequest(get("/api/history/dev", alexToken))
    ).json()) as { records: Signal[] };
    const asKim = (await (
      await connector.handleRequest(get("/api/history/dev", kimToken))
    ).json()) as { records: Signal[] };
    expect(asAlex.records.map((r) => r.id)).toEqual(["h1"]);
    expect(asKim.records).toEqual([]);
  });

  test("logout revokes only the calling user's session", async () => {
    const alexToken = await login("alex");
    const kimToken = await login("kim");
    await connector.handleRequest(post("/api/logout", {}, alexToken));
    expect((await connector.handleRequest(get("/api/peers", alexToken))).status).toBe(401);
    expect((await connector.handleRequest(get("/api/peers", kimToken))).status).toBe(200);
  });
});

describe("self-chat (§17.7, FR-128)", () => {
  test("/api/peers carries the pinned self entry", async () => {
    const body = (await (
      await connector.handleRequest(get("/api/peers", await login("kim")))
    ).json()) as { self?: { name: string; unread: number }; user: string; role: string };
    expect(body.self?.name).toBe("kim");
    expect(body.user).toBe("kim");
  });

  test("the composer can send to SELF — it routes, and the panel does not double-log it", async () => {
    const token = await login("kim");
    const response = await connector.handleRequest(
      post("/api/send", { to: "kim", id: "note-1", text: "remember" }, token),
    );
    expect(response.status).toBe(200);
    expect(inbound[0]).toMatchObject({ from: "kim", to: "kim", payload: "remember" });
    // the note comes back through the user's own egress, so the panel writes nothing
    const history = (await (
      await connector.handleRequest(get("/api/history/kim", token))
    ).json()) as { records: Signal[] };
    expect(history.records).toEqual([]);
  });
});

describe("transport journal by role (§17.7, FR-131)", () => {
  test("an admin gets the journal", async () => {
    expect((await connector.handleRequest(get("/api/transport", await login("alex")))).status).toBe(
      200,
    );
  });

  test("a plain user gets 403 — their own chats are their view", async () => {
    const response = await connector.handleRequest(get("/api/transport", await login("kim")));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/admins only/);
  });
});

describe("DND (§17.8, FR-134)", () => {
  test("a user can pause THEMSELVES", async () => {
    const token = await login("kim");
    const response = await connector.handleRequest(
      post("/api/agents/kim/pause", { paused: true }, token),
    );
    expect(response.status).toBe(200);
    expect(paused.has("kim")).toBe(true);
  });

  test("an admin can pause another user", async () => {
    const token = await login("alex");
    const response = await connector.handleRequest(
      post("/api/agents/kim/pause", { paused: true }, token),
    );
    expect(response.status).toBe(200);
    expect(paused.has("kim")).toBe(true);
  });

  test("a plain user cannot pause someone else — they are not even a peer", async () => {
    const token = await login("kim");
    const response = await connector.handleRequest(
      post("/api/agents/alex/pause", { paused: true }, token),
    );
    expect(response.status).toBe(404);
    expect(paused.has("alex")).toBe(false);
  });
});

describe("users-mode push (§17.5, FR-124)", () => {
  test("pushTo of an unknown user is a no-op, not a throw", () => {
    expect(() =>
      connector.pushTo("ghost", {
        id: "x",
        from: "dev",
        to: "ghost",
        kind: "message",
        ts: 0,
        payload: "hi",
      }),
    ).not.toThrow();
  });
});
