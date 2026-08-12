// T46 (FR-40, §12.4/§12.7): the peers/history/read endpoints over injected
// read-only ports, and the WS push feed (message | ack | status | queue-progress)
// over a real listener. The ports are fakes here — the real injection (topology
// neighbors §10.2, dispatcher status, queue readdir) is exercised end-to-end in
// packages/server/test/webchat.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, Message, Signal } from "@muxeon/core";
import { SESSION_COOKIE, WebchatConnector, type WebchatEvent } from "../src/connector";
import { HistoryStore } from "../src/history";
import type {
  BroadcastPeer,
  CommandFanoutOutcome,
  MessagePhase,
  WebchatLifecycle,
  WebchatPorts,
} from "../src/ports";

let dir: string;
let history: HistoryStore;
let inbound: Message[];

class FakePorts implements WebchatPorts {
  peers: string[] = ["researcher", "writer"];
  statuses = new Map<string, AgentStatus>([
    ["researcher", "idle"],
    ["writer", "down"],
  ]);
  depths = new Map<string, number>();
  phases = new Map<string, MessagePhase>(); // key: `${agent}:${id}`
  limits = new Map<string, number | null>(); // wipLimitOf (FR-104); default null = exempt
  waiting = new Set<string>(); // rendezvous senders (FR-105)
  awaited = new Set<string>(); // rendezvous targets (FR-105)
  kinds = new Map<string, "agent" | "group" | "tag">(); // peerType (§15); default agent
  groups = new Map<string, string>(); // agent → group (§15)
  tagsByAgent = new Map<string, string[]>(); // agent → tags (§15)
  broadcast: BroadcastPeer[] = []; // group/tag peers (§15); default none
  paused = new Set<string>(); // operator-declared pause (§16, FR-119)

  listPeers(): readonly string[] {
    return this.peers;
  }
  peerStatus(name: string): AgentStatus | undefined {
    return this.statuses.get(name);
  }
  peerPaused(name: string): boolean {
    return this.paused.has(name);
  }
  async queueDepth(name: string): Promise<number> {
    return this.depths.get(name) ?? 0;
  }
  async messagePhase(name: string, id: string): Promise<MessagePhase | undefined> {
    return this.phases.get(`${name}:${id}`);
  }
  wipLimitOf(name: string): number | null {
    return this.limits.get(name) ?? null;
  }
  rendezvousState(): { readonly waiting: readonly string[]; readonly awaited: readonly string[] } {
    return { waiting: [...this.waiting], awaited: [...this.awaited] };
  }
  peerType(name: string): "agent" | "group" | "tag" {
    return this.kinds.get(name) ?? "agent";
  }
  agentGroup(name: string): string | undefined {
    return this.groups.get(name);
  }
  agentTags(name: string): readonly string[] {
    return this.tagsByAgent.get(name) ?? [];
  }
  broadcastPeers(): readonly BroadcastPeer[] {
    return this.broadcast;
  }
}

let ports: FakePorts;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-dynamics-"));
  history = new HistoryStore({ dir: join(dir, "operator-web"), operator: "operator-web" });
  inbound = [];
  ports = new FakePorts();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function startedConnector(
  overrides: Partial<ConstructorParameters<typeof WebchatConnector>[0]> = {},
): Promise<WebchatConnector> {
  const connector = new WebchatConnector({
    bindOperator: "operator-web",
    port: 0,
    password: "hunter2",
    history,
    ports,
    pollMs: 20,
    ...overrides,
  });
  await connector.start(async (message) => {
    inbound.push(message);
  });
  return connector;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://panel.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "panel.test", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://panel.test${path}`, { method: "GET", headers });
}

async function login(connector: WebchatConnector): Promise<string> {
  const response = await connector.handleRequest(post("/api/login", { password: "hunter2" }));
  const token = /muxeon_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (token === undefined) throw new Error("no session cookie issued");
  return `${SESSION_COOKIE}=${token}`;
}

const signal = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  from: "researcher",
  to: "operator-web",
  kind: "message",
  ts: Date.now(),
  payload: `news ${id}`,
  ...overrides,
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("GET /api/peers (§12.4, §10.2-scoped)", () => {
  test("returns ONLY the injected neighbor list with status/depth/unread/preview", async () => {
    const connector = await startedConnector();
    try {
      ports.depths.set("researcher", 2);
      await connector.deliver(signal("n-1", { payload: "fresh news" }));
      const cookie = await login(connector);
      const response = await connector.handleRequest(get("/api/peers", { cookie }));
      expect(response.status).toBe(200);
      const { peers } = (await response.json()) as { peers: Record<string, unknown>[] };
      expect(peers.map((p) => p.name)).toEqual(["researcher", "writer"]); // loner-style others never appear
      const researcher = peers[0] as {
        status: string;
        queueDepth: number;
        unread: number;
        lastMessage?: { preview: string; from: string };
      };
      expect(researcher.status).toBe("idle");
      expect(researcher.queueDepth).toBe(2);
      expect(researcher.unread).toBe(1);
      expect(researcher.lastMessage?.preview).toBe("fresh news");
      expect((peers[1] as { status: string }).status).toBe("down");
    } finally {
      await connector.stop();
    }
  });

  test("carries the WIP-cap + rendezvous flags per peer (FR-104/FR-105)", async () => {
    const connector = await startedConnector();
    try {
      ports.limits.set("researcher", 3);
      ports.depths.set("researcher", 3); // depth == cap → at WIP limit
      ports.waiting.add("researcher"); // has an outgoing intent (я жду)
      ports.awaited.add("writer"); // is a target (меня ждут)
      const cookie = await login(connector);
      const { peers } = (await (
        await connector.handleRequest(get("/api/peers", { cookie }))
      ).json()) as {
        peers: { name: string; atWipLimit: boolean; waiting: boolean; awaited: boolean }[];
      };
      const byName = new Map(peers.map((p) => [p.name, p]));
      expect(byName.get("researcher")).toMatchObject({
        atWipLimit: true,
        waiting: true,
        awaited: false,
      });
      expect(byName.get("writer")).toMatchObject({
        atWipLimit: false,
        waiting: false,
        awaited: true,
      });
    } finally {
      await connector.stop();
    }
  });

  test("POST /api/read moves the unread watermark", async () => {
    const connector = await startedConnector();
    try {
      await connector.deliver(signal("u-1"));
      await connector.deliver(signal("u-2"));
      const cookie = await login(connector);
      const before = (await (
        await connector.handleRequest(get("/api/peers", { cookie }))
      ).json()) as { peers: { unread: number }[] };
      expect(before.peers[0]?.unread).toBe(2);
      await connector.handleRequest(post("/api/read", { peer: "researcher" }, { cookie }));
      const after = (await (
        await connector.handleRequest(get("/api/peers", { cookie }))
      ).json()) as { peers: { unread: number }[] };
      expect(after.peers[0]?.unread).toBe(0);
    } finally {
      await connector.stop();
    }
  });
});

describe("groups & tags on the panel surface (§15, FR-112)", () => {
  test("agent peers carry type/group/tags; group/tag peers ride alongside with members, no status", async () => {
    const connector = await startedConnector();
    try {
      ports.groups.set("researcher", "devs");
      ports.tagsByAgent.set("researcher", ["it"]);
      ports.broadcast = [
        { name: "devs", type: "group", parent: "eng", members: ["researcher"] },
        { name: "it", type: "tag", members: ["researcher"] },
      ];
      const cookie = await login(connector);
      const { peers } = (await (
        await connector.handleRequest(get("/api/peers", { cookie }))
      ).json()) as { peers: Record<string, unknown>[] };
      const byName = new Map(peers.map((p) => [p.name as string, p]));
      expect(byName.get("researcher")).toMatchObject({
        type: "agent",
        group: "devs",
        tags: ["it"],
      });
      expect(byName.get("devs")).toEqual({
        name: "devs",
        type: "group",
        parent: "eng",
        members: ["researcher"],
      });
      expect(byName.get("it")).toEqual({ name: "it", type: "tag", members: ["researcher"] });
      expect(byName.get("devs")).not.toHaveProperty("status"); // input-only, no status
    } finally {
      await connector.stop();
    }
  });

  test("raw mode to a group/tag is rejected (400); a normal broadcast reaches the router", async () => {
    const connector = await startedConnector();
    try {
      ports.kinds.set("eng", "group");
      const cookie = await login(connector);
      const rawRes = await connector.handleRequest(
        post("/api/send", { to: "eng", id: "r1", text: "hi", raw: true }, { cookie }),
      );
      expect(rawRes.status).toBe(400);
      expect(inbound).toHaveLength(0); // never routed
      const okRes = await connector.handleRequest(
        post("/api/send", { to: "eng", id: "b1", text: "all hands" }, { cookie }),
      );
      expect(okRes.status).toBe(200);
      expect(inbound.map((m) => m.to)).toEqual(["eng"]); // the router fans it out (§15.4)
    } finally {
      await connector.stop();
    }
  });
});

// POST /api/agents/command (§15.8, FR-115): the panel command-fanout route. Here
// the fanout port is a fake that embodies the per-agent neighbour gate the real
// bootstrap wires (§10.2); the CONNECTOR's job is to validate, call it, and pass
// the aggregate (COMMAND_DENIED entries included) through untouched.
describe("POST /api/agents/command (§15.8, FR-115)", () => {
  const lifecycleWithFanout = (neighbours: readonly string[]): WebchatLifecycle => ({
    actions: () => ({ shutdown: false, reload: false }),
    shutdown: async () => "down" as AgentStatus,
    reload: async () => "idle" as AgentStatus,
    commands: () => [],
    runCommand: async () => "",
    commandFanout: async (slash, selectors): Promise<CommandFanoutOutcome> => {
      if (selectors.includes("ghost")) {
        return { ok: false, code: "UNKNOWN_SELECTOR", message: "unknown selector(s): ghost" };
      }
      const nb = new Set(neighbours);
      const targets = ["alice", "bob"]; // pretend the intersection resolved to these
      return {
        ok: true,
        kind: "command-fanout",
        slash,
        selectors,
        targets,
        fanout: targets.map((to) =>
          nb.has(to)
            ? { to, ok: true, output: `ran /${slash}` }
            : { to, ok: false, code: "COMMAND_DENIED", output: "not a topology neighbour" },
        ),
      };
    },
  });

  test("dispatches the aggregate; a non-neighbour agent comes back COMMAND_DENIED", async () => {
    const connector = await startedConnector({ lifecycle: lifecycleWithFanout(["alice"]) });
    try {
      const cookie = await login(connector);
      const res = await connector.handleRequest(
        post("/api/agents/command", { slash: "compact", selectors: ["devs"] }, { cookie }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as CommandFanoutOutcome;
      if (!body.ok) throw new Error("expected ok");
      expect(body.targets).toEqual(["alice", "bob"]);
      expect(body.fanout).toEqual([
        { to: "alice", ok: true, output: "ran /compact" },
        { to: "bob", ok: false, code: "COMMAND_DENIED", output: "not a topology neighbour" },
      ]);
    } finally {
      await connector.stop();
    }
  });

  test("an unknown selector is surfaced as 400", async () => {
    const connector = await startedConnector({ lifecycle: lifecycleWithFanout(["alice"]) });
    try {
      const cookie = await login(connector);
      const res = await connector.handleRequest(
        post("/api/agents/command", { slash: "compact", selectors: ["ghost"] }, { cookie }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("UNKNOWN_SELECTOR");
    } finally {
      await connector.stop();
    }
  });

  test("missing slash / selectors → 400; no lifecycle port → 503", async () => {
    const withPort = await startedConnector({ lifecycle: lifecycleWithFanout(["alice"]) });
    try {
      const cookie = await login(withPort);
      const noSlash = await withPort.handleRequest(
        post("/api/agents/command", { selectors: ["devs"] }, { cookie }),
      );
      expect(noSlash.status).toBe(400);
      const noSel = await withPort.handleRequest(
        post("/api/agents/command", { slash: "compact" }, { cookie }),
      );
      expect(noSel.status).toBe(400);
    } finally {
      await withPort.stop();
    }
    const noPort = await startedConnector(); // lifecycle undefined
    try {
      const cookie = await login(noPort);
      const res = await noPort.handleRequest(
        post("/api/agents/command", { slash: "compact", selectors: ["devs"] }, { cookie }),
      );
      expect(res.status).toBe(503);
    } finally {
      await noPort.stop();
    }
  });

  test("the route is gated by auth (§10.12) — no cookie → 401", async () => {
    const connector = await startedConnector({ lifecycle: lifecycleWithFanout(["alice"]) });
    try {
      const res = await connector.handleRequest(
        post("/api/agents/command", { slash: "compact", selectors: ["devs"] }),
      );
      expect(res.status).toBe(401);
    } finally {
      await connector.stop();
    }
  });
});

describe("GET /api/history/:agent (§12.4)", () => {
  test("pages backwards with before/limit", async () => {
    const connector = await startedConnector();
    try {
      for (let i = 0; i < 5; i += 1) {
        await connector.deliver(signal(`h-${i}`, { ts: Date.now() + i }));
      }
      const cookie = await login(connector);
      const page1 = (await (
        await connector.handleRequest(get("/api/history/researcher?limit=2", { cookie }))
      ).json()) as { records: { id: string }[]; nextBefore?: string };
      expect(page1.records.map((r) => r.id)).toEqual(["h-3", "h-4"]);
      expect(page1.nextBefore).toBe("h-3");
      const page2 = (await (
        await connector.handleRequest(
          get(`/api/history/researcher?limit=2&before=${page1.nextBefore}`, { cookie }),
        )
      ).json()) as { records: { id: string }[] };
      expect(page2.records.map((r) => r.id)).toEqual(["h-1", "h-2"]);
    } finally {
      await connector.stop();
    }
  });

  test("unauthenticated history/peers stay behind the gate (§10.12)", async () => {
    const connector = await startedConnector();
    try {
      expect((await connector.handleRequest(get("/api/history/researcher"))).status).toBe(401);
      expect((await connector.handleRequest(get("/api/peers"))).status).toBe(401);
    } finally {
      await connector.stop();
    }
  });
});

describe("WS /api/ws push feed (§12.4)", () => {
  async function wsClient(
    connector: WebchatConnector,
    cookie: string,
  ): Promise<{ events: WebchatEvent[]; socket: WebSocket }> {
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

  test("an unauthenticated upgrade is rejected before any core port (§10.12)", async () => {
    const connector = await startedConnector();
    try {
      const response = await fetch(`http://127.0.0.1:${connector.port}/api/ws`);
      expect(response.status).toBe(401);
    } finally {
      await connector.stop();
    }
  });

  test("deliver → message event; send → ack + message + queue-progress; status diffs push", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      const { events, socket } = await wsClient(connector, cookie);

      // initial status snapshot arrives via the first poll diff
      await waitFor(() => events.filter((e) => e.type === "status").length >= 2);

      // inbound: deliver → message push
      await connector.deliver(signal("ws-in-1"));
      await waitFor(() => events.some((e) => e.type === "message" && e.record.id === "ws-in-1"));

      // outbound: send → ack + message, then the tracked id's phase moves
      ports.phases.set("researcher:ws-out-1", "pending");
      const sent = await fetch(`http://127.0.0.1:${connector.port}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ to: "researcher", text: "go", id: "ws-out-1" }),
      });
      expect(sent.status).toBe(200);
      await waitFor(() => events.some((e) => e.type === "ack" && e.id === "ws-out-1"));
      await waitFor(() =>
        events.some(
          (e) => e.type === "queue-progress" && e.id === "ws-out-1" && e.phase === "pending",
        ),
      );
      ports.phases.set("researcher:ws-out-1", "done");
      await waitFor(() =>
        events.some(
          (e) => e.type === "queue-progress" && e.id === "ws-out-1" && e.phase === "done",
        ),
      );

      // status change → a fresh status event
      ports.statuses.set("researcher", "busy");
      await waitFor(() =>
        events.some((e) => e.type === "status" && e.peer === "researcher" && e.status === "busy"),
      );
      socket.close();
    } finally {
      await connector.stop();
    }
  });

  test("a rendezvous flip pushes a status event with no status/depth change (FR-105)", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      const { events, socket } = await wsClient(connector, cookie);
      await waitFor(() => events.filter((e) => e.type === "status").length >= 2); // initial snapshot
      // researcher becomes "waiting" — its status stays idle and depth stays 0
      ports.waiting.add("researcher");
      await waitFor(() =>
        events.some((e) => e.type === "status" && e.peer === "researcher" && e.waiting === true),
      );
      socket.close();
    } finally {
      await connector.stop();
    }
  });

  test("surface has NO operator-plane routes (§10.10/§10.12 capability cap)", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      for (const path of [
        "/api/lifecycle/restart",
        "/api/queues/edit",
        "/api/routines",
        "/api/channels",
        "/api/signals",
      ]) {
        const viaGet = await connector.handleRequest(get(path, { cookie }));
        expect(viaGet.status).toBe(404);
        const viaPost = await connector.handleRequest(post(path, {}, { cookie }));
        expect(viaPost.status).toBe(404);
      }
    } finally {
      await connector.stop();
    }
  });
});

describe("pause on the panel surface (§16.5/§16.6, FR-119/FR-120)", () => {
  /** A lifecycle port whose pause flag lives in the shared FakePorts set. */
  const pausingLifecycle = (opts: { wired?: boolean } = {}): WebchatLifecycle => ({
    actions: () => ({ shutdown: true, reload: false, pause: true }),
    shutdown: async () => "down" as AgentStatus,
    reload: async () => "idle" as AgentStatus,
    commands: () => [],
    runCommand: async () => "",
    ...(opts.wired === false
      ? {}
      : {
          pause: async (name: string, paused: boolean): Promise<boolean> => {
            if (paused) ports.paused.add(name);
            else ports.paused.delete(name);
            return ports.paused.has(name);
          },
        }),
  });

  test("/api/peers carries `paused` and `actions.pause` per agent peer", async () => {
    const connector = await startedConnector({ lifecycle: pausingLifecycle() });
    try {
      ports.paused.add("writer");
      const cookie = await login(connector);
      const response = await connector.handleRequest(get("/api/peers", { cookie }));
      const { peers } = (await response.json()) as {
        peers: { name: string; paused: boolean; status: string; actions?: { pause?: boolean } }[];
      };
      expect(peers.map((p) => [p.name, p.paused])).toEqual([
        ["researcher", false],
        ["writer", true],
      ]);
      // the status is untouched by the pause (§16.1) and the action is offered
      expect(peers[1]?.status).toBe("down");
      expect(peers[1]?.actions?.pause).toBe(true);
    } finally {
      await connector.stop();
    }
  });

  test("POST /api/agents/:name/pause sets the DESIRED state and is idempotent", async () => {
    const connector = await startedConnector({ lifecycle: pausingLifecycle() });
    try {
      const cookie = await login(connector);
      for (const _ of [1, 2]) {
        const res = await connector.handleRequest(
          post("/api/agents/writer/pause", { paused: true }, { cookie }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, paused: true });
      }
      const resumed = await connector.handleRequest(
        post("/api/agents/writer/pause", { paused: false }, { cookie }),
      );
      expect(await resumed.json()).toEqual({ ok: true, paused: false });
      expect(ports.paused.has("writer")).toBe(false);
    } finally {
      await connector.stop();
    }
  });

  test("a non-neighbour is 404, a non-boolean body is 400, an unwired port is 503", async () => {
    const connector = await startedConnector({ lifecycle: pausingLifecycle() });
    try {
      const cookie = await login(connector);
      const stranger = await connector.handleRequest(
        post("/api/agents/ghost/pause", { paused: true }, { cookie }),
      );
      expect(stranger.status).toBe(404); // structural neighbour gate (§10.2)
      const bad = await connector.handleRequest(
        post("/api/agents/writer/pause", { paused: "yes" }, { cookie }),
      );
      expect(bad.status).toBe(400);
    } finally {
      await connector.stop();
    }
    const unwired = await startedConnector({ lifecycle: pausingLifecycle({ wired: false }) });
    try {
      const cookie = await login(unwired);
      const res = await unwired.handleRequest(
        post("/api/agents/writer/pause", { paused: true }, { cookie }),
      );
      expect(res.status).toBe(503);
    } finally {
      await unwired.stop();
    }
  });

  test("the pause endpoint is behind the auth gate (§10.12)", async () => {
    const connector = await startedConnector({ lifecycle: pausingLifecycle() });
    try {
      const res = await connector.handleRequest(post("/api/agents/writer/pause", { paused: true }));
      expect(res.status).toBe(401);
      expect(ports.paused.has("writer")).toBe(false); // never reached the port
    } finally {
      await connector.stop();
    }
  });

  test("a pause flip pushes a `status` event carrying `paused` — every tab repaints", async () => {
    const connector = await startedConnector({ lifecycle: pausingLifecycle() });
    try {
      const cookie = await login(connector);
      const events: WebchatEvent[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${connector.port}/api/ws`, {
        headers: { cookie },
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String(event.data)) as WebchatEvent);
      });
      await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
      // the first poll tick establishes the baseline for both peers
      await waitFor(() => events.filter((e) => e.type === "status").length >= 2);
      events.length = 0;
      ports.paused.add("writer");
      await waitFor(() =>
        events.some((e) => e.type === "status" && e.peer === "writer" && e.paused === true),
      );
      socket.close();
    } finally {
      await connector.stop();
    }
  });
});
