// T64 (FR-48, §12.4): the read-only transport observability surface —
// GET /api/transport behind the §10.12 auth gate + the live WS `transport`
// push from the injected subscription. The port is a fake here; the real
// injection (router → TransportLog → connector) is exercised end-to-end in
// packages/server/test/webchat.test.ts.

import { describe, expect, test } from "bun:test";
import type { Signal } from "@teamai/core";
import { SESSION_COOKIE, WebchatConnector, type WebchatEvent } from "../src/connector";
import type { TransportObservability, TransportPage } from "../src/ports";

class FakeTransport implements TransportObservability {
  pages: Array<{ before?: string; limit?: number }> = [];
  records: Signal[] = [];
  listeners = new Set<(record: Signal) => void>();

  async page(options: { before?: string; limit?: number } = {}): Promise<TransportPage> {
    this.pages.push(options);
    return { records: this.records };
  }

  subscribe(listener: (record: Signal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(record: Signal): void {
    for (const listener of this.listeners) listener(record);
  }
}

const record = (id: string): Signal => ({
  id,
  from: "teamai",
  to: "qwen",
  kind: "message",
  ts: 1000,
  payload: `routed ${id}`,
});

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://panel.test${path}`, { method: "GET", headers });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://panel.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "panel.test" },
    body: JSON.stringify(body),
  });
}

async function startedConnector(transport: FakeTransport | undefined): Promise<WebchatConnector> {
  const connector = new WebchatConnector({
    bindOperator: "operator-web",
    port: 0,
    password: "hunter2",
    ...(transport !== undefined ? { transport } : {}),
  });
  await connector.start(async () => undefined);
  return connector;
}

async function loginCookie(connector: WebchatConnector): Promise<Record<string, string>> {
  const response = await connector.handleRequest(post("/api/login", { password: "hunter2" }));
  const token = /teamai_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (token === undefined) throw new Error("no session cookie issued");
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

describe("GET /api/transport (§12.4, FR-48)", () => {
  test("unauthenticated → 401 and the observability port is NEVER touched (§10.12)", async () => {
    const transport = new FakeTransport();
    const connector = await startedConnector(transport);
    try {
      const response = await connector.handleRequest(get("/api/transport"));
      expect(response.status).toBe(401);
      expect(transport.pages).toHaveLength(0);
    } finally {
      await connector.stop();
    }
  });

  test("authenticated → the page, with before/limit passed through (limit clamped)", async () => {
    const transport = new FakeTransport();
    transport.records = [record("a"), record("b")];
    const connector = await startedConnector(transport);
    try {
      const cookie = await loginCookie(connector);
      const response = await connector.handleRequest(get("/api/transport", cookie));
      expect(response.status).toBe(200);
      const body = (await response.json()) as TransportPage;
      expect(body.records.map((r) => r.id)).toEqual(["a", "b"]);
      expect(transport.pages.at(-1)).toEqual({ limit: 50 });

      await connector.handleRequest(get("/api/transport?before=x&limit=10", cookie));
      expect(transport.pages.at(-1)).toEqual({ before: "x", limit: 10 });

      await connector.handleRequest(get("/api/transport?limit=9999", cookie));
      expect(transport.pages.at(-1)).toEqual({ limit: 200 }); // clamped
    } finally {
      await connector.stop();
    }
  });

  test("no transport port wired → 503", async () => {
    const connector = await startedConnector(undefined);
    try {
      const cookie = await loginCookie(connector);
      const response = await connector.handleRequest(get("/api/transport", cookie));
      expect(response.status).toBe(503);
    } finally {
      await connector.stop();
    }
  });
});

describe("WS transport push (§12.4, FR-48)", () => {
  test("a routed record reaches connected tabs; stop() unsubscribes", async () => {
    const transport = new FakeTransport();
    const connector = await startedConnector(transport);
    try {
      expect(transport.listeners.size).toBe(1); // subscribed on start
      const { cookie } = await loginCookie(connector);
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

      transport.emit(record("live-1"));
      const deadline = Date.now() + 5000;
      while (!events.some((e) => e.type === "transport" && e.record.id === "live-1")) {
        if (Date.now() > deadline) throw new Error("timeout waiting for the transport push");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      socket.close();
    } finally {
      await connector.stop();
    }
    expect(transport.listeners.size).toBe(0); // unsubscribed on stop
  });
});
