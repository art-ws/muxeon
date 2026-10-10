// §23.3 (FR-209…FR-213, FR-216): the topic surface of the panel — CRUD routes and
// their codes, `topicId` on send (checked before route), topic feeds and reads,
// the export part, the pair gate, and the WS pushes (message/ack topicId,
// topics-changed, history-cleared with the removed ids).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, Message, Signal } from "@muxeon/core";
import { SESSION_COOKIE, WebchatConnector, type WebchatEvent } from "../src/connector";
import { HistoryStore } from "../src/history";
import type { MessagePhase, WebchatPorts } from "../src/ports";
import { DEFAULT_TOPIC_ID, type TopicView } from "../src/topics";

const ME = "operator-web";
const AGENT = "researcher";

class Ports implements WebchatPorts {
  peers = [AGENT, "writer", "crew"];
  listPeers(): readonly string[] {
    return this.peers;
  }
  peerStatus(): AgentStatus | undefined {
    return "idle";
  }
  async queueDepth(): Promise<number> {
    return 0;
  }
  async messagePhase(): Promise<MessagePhase | undefined> {
    return undefined;
  }
  peerType(name: string): "agent" | "group" | "tag" {
    return name === "crew" ? "group" : "agent";
  }
}

let dir: string;
let history: HistoryStore;
let inbound: Message[];
let connector: WebchatConnector;
let cookie: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-topics-http-"));
  history = new HistoryStore({ dir: join(dir, ME), operator: ME });
  inbound = [];
  connector = new WebchatConnector({
    bindOperator: ME,
    port: 0,
    password: "hunter2",
    history,
    ports: new Ports(),
    pollMs: 20,
  });
  await connector.start(async (message) => {
    inbound.push(message);
  });
  const response = await connector.handleRequest(
    call("POST", "/api/login", { password: "hunter2" }),
  );
  const token = /muxeon_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  cookie = `${SESSION_COOKIE}=${token}`;
});

afterEach(async () => {
  await connector.stop();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Request {
  return new Request(`http://panel.test${path}`, {
    method,
    headers: {
      host: "panel.test",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie !== undefined ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await connector.handleRequest(call(method, path, body));
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
}

async function topics(peer = AGENT): Promise<TopicView[]> {
  return (await api("GET", `/api/topics/${peer}`)).body.topics as TopicView[];
}

async function create(path: string): Promise<string> {
  const response = await api("POST", `/api/topics/${AGENT}`, { path });
  expect(response.status).toBe(201);
  return (response.body.topic as { id: string }).id;
}

function reply(id: string, replyTo: string): Signal {
  return { id, from: AGENT, to: ME, kind: "message", ts: Date.now(), payload: id, replyTo };
}

describe("topic CRUD (§23.3)", () => {
  test("list → create (with ancestors) → rename → delete, with the API's codes", async () => {
    expect((await topics()).map((t) => t.path)).toEqual(["Общая"]);
    const leaf = await create("Проект/Релиз");
    expect((await topics()).map((t) => t.path).sort()).toEqual(["Общая", "Проект", "Проект/Релиз"]);
    expect((await api("POST", `/api/topics/${AGENT}`, { path: "проект" })).body.code).toBe(
      "TOPIC_EXISTS",
    );
    expect((await api("POST", `/api/topics/${AGENT}`, { path: "a//b" })).status).toBe(400);
    const parent = (await topics()).find((t) => t.path === "Проект")?.id as string;
    const renamed = await api("PATCH", `/api/topics/${AGENT}/${parent}`, { path: "Работа" });
    expect(renamed.status).toBe(200);
    expect((await topics()).find((t) => t.id === leaf)?.path).toBe("Работа/Релиз");
    expect(
      (await api("PATCH", `/api/topics/${AGENT}/${parent}`, { path: "Общая" })).body.code,
    ).toBe("TOPIC_CONFLICT");
    expect((await api("DELETE", `/api/topics/${AGENT}/${DEFAULT_TOPIC_ID}`)).body.code).toBe(
      "DEFAULT_TOPIC",
    );
    expect((await api("DELETE", `/api/topics/${AGENT}/${parent}`)).status).toBe(204);
    expect((await topics()).map((t) => t.path)).toEqual(["Общая"]);
    expect((await api("DELETE", `/api/topics/${AGENT}/${parent}`)).status).toBe(404);
  });

  test("only a visible AGENT chat has topics: group, non-neighbour, unknown → 404", async () => {
    expect((await api("GET", "/api/topics/crew")).status).toBe(404); // a group (§15)
    expect((await api("GET", "/api/topics/stranger")).status).toBe(404); // not a neighbour
    expect((await api("POST", "/api/topics/stranger", { path: "x" })).status).toBe(404);
  });

  test("unauthenticated topic calls stop at the auth gate", async () => {
    const response = await connector.handleRequest(
      new Request(`http://panel.test/api/topics/${AGENT}`, { headers: { host: "panel.test" } }),
    );
    expect(response.status).toBe(401);
  });
});

describe("send, feeds and reads (§23.2/§23.3)", () => {
  test("a send carries its topic; a bad topic is refused BEFORE route", async () => {
    const topic = await create("Bugs");
    const bad = await api("POST", "/api/send", { to: AGENT, id: "m0", text: "x", topicId: "nope" });
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe("TOPIC_NOT_FOUND");
    const wrongPeer = await api("POST", "/api/send", {
      to: "crew",
      id: "g0",
      text: "x",
      topicId: topic,
    });
    expect(wrongPeer.status).toBe(404);
    expect(inbound).toEqual([]); // nothing reached the router
    const ok = await api("POST", "/api/send", { to: AGENT, id: "m1", text: "hi", topicId: topic });
    expect(ok.status).toBe(200);
    expect(ok.body.topicId).toBe(topic);
    expect(inbound.map((m) => m.id)).toEqual(["m1"]);
    expect(Object.hasOwn(inbound[0] as object, "topicId")).toBe(false); // not a Signal field
    const conflict = await api("POST", "/api/send", {
      to: AGENT,
      id: "m1",
      text: "hi",
      topicId: DEFAULT_TOPIC_ID,
    });
    expect(conflict.body.code).toBe("MESSAGE_TOPIC_CONFLICT");
    // an old client without topicId lands in the default topic
    await api("POST", "/api/send", { to: AGENT, id: "m2", text: "legacy" });
    await connector.deliver(reply("m1:reply", "m1"));
    const feed = await api("GET", `/api/history/${AGENT}?topicId=${topic}`);
    expect((feed.body.records as Signal[]).map((r) => r.id)).toEqual(["m1", "m1:reply"]);
    const all = await api("GET", `/api/history/${AGENT}`);
    expect((all.body.records as Signal[]).map((r) => r.id)).toEqual(["m1", "m2", "m1:reply"]);
    expect((await api("GET", `/api/history/${AGENT}?topicId=nope`)).status).toBe(404);
  });

  test("POST /api/read with a topic reads only that topic; without — the whole pair", async () => {
    const topic = await create("A");
    await api("POST", "/api/send", { to: AGENT, id: "qa", text: "a", topicId: topic });
    await api("POST", "/api/send", { to: AGENT, id: "qd", text: "d" });
    await connector.deliver(reply("ra", "qa"));
    await connector.deliver(reply("rd", "qd"));
    const unreadOf = async (): Promise<number> => {
      const peers = (await api("GET", "/api/peers")).body.peers as {
        name: string;
        unread: number;
      }[];
      return peers.find((p) => p.name === AGENT)?.unread ?? -1;
    };
    expect(await unreadOf()).toBe(2);
    expect((await api("POST", "/api/read", { peer: AGENT, topicId: topic })).status).toBe(200);
    expect(await unreadOf()).toBe(1);
    expect((await api("POST", "/api/read", { peer: AGENT, topicId: "nope" })).status).toBe(404);
    await api("POST", "/api/read", { peer: AGENT });
    expect(await unreadOf()).toBe(0);
  });

  test("export carries the tree and the membership beside verbatim records", async () => {
    const topic = await create("A");
    await api("POST", "/api/send", { to: AGENT, id: "a1", text: "a", topicId: topic });
    const response = await connector.handleRequest(call("GET", `/api/history/${AGENT}/export`));
    const doc = (await response.json()) as Record<string, unknown>;
    expect(doc.defaultId).toBe(DEFAULT_TOPIC_ID);
    expect((doc.topics as { path: string }[]).map((t) => t.path).sort()).toEqual(["A", "Общая"]);
    expect(doc.messageTopics).toEqual({ a1: topic });
    expect((doc.records as Signal[])[0]).not.toHaveProperty("topicId");
  });
});

describe("WS pushes (§23.3)", () => {
  async function feed(): Promise<{ events: WebchatEvent[]; socket: WebSocket }> {
    const events: WebchatEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${connector.port}/api/ws`, {
      headers: { cookie },
    });
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String(event.data)) as WebchatEvent);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return { events, socket };
  }

  async function until(events: WebchatEvent[], check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(events)}`);
      await Bun.sleep(10);
    }
  }

  test("message/ack carry topicId; delete pushes the removed ids and the new tree", async () => {
    const { events, socket } = await feed();
    try {
      const topic = await create("A");
      await until(events, () => events.some((e) => e.type === "topics-changed"));
      await api("POST", "/api/send", { to: AGENT, id: "a1", text: "a", topicId: topic });
      await connector.deliver(reply("a1:reply", "a1"));
      await until(events, () =>
        events.some((e) => e.type === "message" && e.record.id === "a1:reply"),
      );
      const ack = events.find((e) => e.type === "ack" && e.id === "a1");
      expect(ack).toMatchObject({ topicId: topic });
      const answer = events.find((e) => e.type === "message" && e.record.id === "a1:reply");
      expect(answer).toMatchObject({ topicId: topic });
      events.length = 0;
      await api("DELETE", `/api/topics/${AGENT}/${topic}`);
      await until(events, () => events.some((e) => e.type === "topics-changed"));
      const cleared = events.find((e) => e.type === "history-cleared");
      expect(cleared).toMatchObject({ peer: AGENT, topicId: topic });
      const removed = cleared?.type === "history-cleared" ? [...(cleared.ids ?? [])] : [];
      expect(removed.sort()).toEqual(["a1", "a1:reply"]);
      const changed = events.find((e) => e.type === "topics-changed");
      const tree: readonly TopicView[] = changed?.type === "topics-changed" ? changed.topics : [];
      expect(tree.map((t) => t.path)).toEqual(["Общая"]);
    } finally {
      socket.close();
    }
  });
});
