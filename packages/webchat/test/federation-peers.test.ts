// §18.4 (FR-144/FR-150): federated peers on the panel surface — read-only rows
// in /api/peers (projection + server/link, actions all-false, commands empty)
// and the SAME WS status-diff mechanism as local peers (no second push path).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_COOKIE, WebchatConnector } from "../src/connector";
import { HistoryStore } from "../src/history";
import type { RemotePeerRow, WebchatPorts } from "../src/ports";

let dir: string;
let history: HistoryStore;

class FakePorts implements WebchatPorts {
  remote: RemotePeerRow[] = [
    {
      name: "dev@hq",
      type: "agent",
      server: "hq",
      link: "up",
      status: "idle",
      paused: false,
    },
    {
      name: "kim@hq",
      type: "user",
      server: "hq",
      link: "up",
      presence: "online",
      paused: false,
    },
  ];
  listPeers(): readonly string[] {
    return [];
  }
  peerStatus(): undefined {
    return undefined;
  }
  async queueDepth(): Promise<number> {
    return 0;
  }
  async messagePhase(): Promise<undefined> {
    return undefined;
  }
  remotePeers(): readonly RemotePeerRow[] {
    return this.remote;
  }
}

let ports: FakePorts;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-fed-panel-"));
  history = new HistoryStore({ dir: join(dir, "operator-web"), operator: "operator-web" });
  ports = new FakePorts();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function startedConnector(): Promise<WebchatConnector> {
  const connector = new WebchatConnector({
    bindOperator: "operator-web",
    port: 0,
    password: "hunter2",
    history,
    ports,
    pollMs: 20,
  });
  await connector.start(async () => undefined);
  return connector;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://panel.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "panel.test" },
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

describe("§18.4 federated peers on the panel surface", () => {
  test("/api/peers carries read-only remote rows (FR-144/FR-150)", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      const response = await connector.handleRequest(get("/api/peers", { cookie }));
      const body = (await response.json()) as { peers: Record<string, unknown>[] };
      const dev = body.peers.find((peer) => peer.name === "dev@hq");
      // The projection + the link, and NO console affordances: the chrome the
      // panel derives (no lifecycle, no slash commands, no console) follows
      // from actions/commands, not from client-side special-casing.
      expect(dev).toMatchObject({
        type: "agent",
        server: "hq",
        link: "up",
        status: "idle",
        paused: false,
        actions: { shutdown: false, reload: false, pause: false },
        commands: [],
      });
      const kim = body.peers.find((peer) => peer.name === "kim@hq");
      expect(kim).toMatchObject({ type: "user", presence: "online" });
    } finally {
      await connector.stop();
    }
  });

  test("remote status changes ride the SAME WS diff as local ones (FR-150)", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      const events: Record<string, unknown>[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${connector.port}/api/ws`, {
        headers: { cookie },
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      // The first poll pushes the initial remote dynamics...
      await waitFor(() => events.some((event) => event.peer === "dev@hq"));
      // ...and a link death arrives as `unknown` + the cause (§10.27), never a
      // stale value: flip the registry fake and watch the diff fire.
      ports.remote = ports.remote.map((peer) =>
        peer.type === "agent"
          ? { ...peer, link: "down", status: "unknown", reason: "link-down" }
          : peer,
      );
      await waitFor(() =>
        events.some(
          (event) => event.peer === "dev@hq" && event.status === "unknown" && event.link === "down",
        ),
      );
      const dark = events.findLast((event) => event.peer === "dev@hq");
      expect(dark).toMatchObject({ reason: "link-down", server: "hq" });
      socket.close();
    } finally {
      await connector.stop();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
