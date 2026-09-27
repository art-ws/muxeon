// The panel's alarm surface (§22.4, FR-205) over the real connector: the auth
// gate (§10.12), the audience scoping (§10.22), the WS push of the whole slot, the
// "watching" count the agent is told, and the answer's trace in the history.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { type Alarm, AlarmsHub } from "../src/alarms";
import { SESSION_COOKIE, WebchatConnector } from "../src/connector";
import { HistoryStore } from "../src/history";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-alarms-http-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ports = {
  listPeers: () => ["dev"],
  peerStatus: () => "idle" as const,
  peerType: () => "agent" as const,
  queueDepth: async () => 0,
  messagePhase: async () => undefined,
};

interface Harness {
  connector: WebchatConnector;
  hub: AlarmsHub;
  history: HistoryStore;
  routed: Signal[];
  token: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
}

async function harness(options: { enabled?: boolean; audience?: string[] } = {}): Promise<Harness> {
  const history = new HistoryStore({ dir: join(root, "history", "alex"), operator: "alex" });
  const routed: Signal[] = [];
  const hub = new AlarmsHub({
    enabled: options.enabled ?? true,
    limits: { maxText: 4096, maxOptions: 6, maxOptionLength: 80 },
    dir: join(root, "state", "alarms"),
    isAgent: (name) => name === "dev",
    audienceOf: () => options.audience ?? ["alex"],
    route: async (signal) => {
      routed.push(signal);
      return { ok: true };
    },
  });
  const connector = new WebchatConnector({
    port: 0,
    users: [{ name: "alex", role: "admin", password: "hunter2", history, ports }],
    alarms: hub,
  });
  await connector.start(async () => undefined);
  const base = `http://127.0.0.1:${connector.port}`;
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "alex", password: "hunter2" }),
  });
  const token = /muxeon_webchat=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        cookie: `${SESSION_COOKIE}=${token}`,
      },
    });
  return {
    connector,
    hub,
    history,
    routed,
    token,
    request,
    post: (path, body) =>
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

async function raise(h: Harness, input: Record<string, unknown> = {}): Promise<string> {
  const out = await h.hub.call("dev", { text: "help", level: 0.9, ...input });
  if (!out.ok) throw new Error(out.code);
  return out.id;
}

describe("GET /api/alarms (§22.4)", () => {
  test("the viewer's neighbours' ACTIVE alarms, behind the auth gate", async () => {
    const h = await harness();
    try {
      await raise(h, { options: ["Yes", "No"] });
      const anonymous = await fetch(`http://127.0.0.1:${h.connector.port}/api/alarms`);
      expect(anonymous.status).toBe(401);
      const body = (await (await h.request("/api/alarms")).json()) as { alarms: Alarm[] };
      expect(body.alarms).toHaveLength(1);
      expect(body.alarms[0]).toMatchObject({ agent: "dev", level: 0.9, state: "raised" });
    } finally {
      await h.connector.stop();
    }
  });

  test("an alarm the viewer is not an audience of does not exist for them (§10.22)", async () => {
    const h = await harness({ audience: ["maria"] });
    try {
      const id = await raise(h);
      const body = (await (await h.request("/api/alarms")).json()) as { alarms: Alarm[] };
      expect(body.alarms).toEqual([]);
      const seen = await h.post(`/api/alarms/dev/${id}/seen`);
      expect(seen.status).toBe(404);
      expect(((await seen.json()) as { code: string }).code).toBe("UNKNOWN_ALARM");
    } finally {
      await h.connector.stop();
    }
  });

  test("switched off ⇒ 409 ALARMS_DISABLED on every alarm endpoint (§22.8)", async () => {
    const h = await harness({ enabled: false });
    try {
      const list = await h.request("/api/alarms");
      expect(list.status).toBe(409);
      expect(((await list.json()) as { code: string }).code).toBe("ALARMS_DISABLED");
      expect((await h.post("/api/alarms/dev/x/seen")).status).toBe(409);
    } finally {
      await h.connector.stop();
    }
  });
});

describe("POST /api/alarms/:agent/:id/… (§22.4/§22.5)", () => {
  test("answer routes ONE notice and records it in the viewer's history", async () => {
    const h = await harness();
    try {
      const id = await raise(h, { options: ["Roll back", "Fix forward"] });
      const response = await h.post(`/api/alarms/dev/${encodeURIComponent(id)}/answer`, {
        option: 1,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { alarm: Alarm; notify: { delivered: boolean } };
      expect(body.alarm).toMatchObject({ state: "answered", answer: 1, resolvedBy: "alex" });
      expect(body.notify.delivered).toBe(true);
      expect(h.routed).toHaveLength(1);
      expect(h.routed[0]).toMatchObject({ from: "alex", to: "dev", expectsReply: false });
      // the trace in the chat IS the signal (§22.5)
      const records = await h.history.all("dev");
      expect(records.map((record) => record.id)).toEqual([`${id}:resolution`]);
    } finally {
      await h.connector.stop();
    }
  });

  test("the losing click is told who won (409 ALARM_RESOLVED with the slot)", async () => {
    const h = await harness();
    try {
      const id = await raise(h, { options: ["A", "B"] });
      await h.post(`/api/alarms/dev/${id}/answer`, { option: 0 });
      const late = await h.post(`/api/alarms/dev/${id}/answer`, { option: 1 });
      expect(late.status).toBe(409);
      const body = (await late.json()) as { code: string; alarm: Alarm };
      expect(body.code).toBe("ALARM_RESOLVED");
      expect(body.alarm.resolvedBy).toBe("alex");
    } finally {
      await h.connector.stop();
    }
  });

  test("a bad option is 400 UNKNOWN_OPTION; an unknown action is 404", async () => {
    const h = await harness();
    try {
      const id = await raise(h, { options: ["A"] });
      expect((await h.post(`/api/alarms/dev/${id}/answer`, { option: 5 })).status).toBe(400);
      expect((await h.post(`/api/alarms/dev/${id}/shout`)).status).toBe(404);
    } finally {
      await h.connector.stop();
    }
  });

  test("seen → dismiss: quiet first, then closed with one receipt", async () => {
    const h = await harness();
    try {
      const id = await raise(h, { options: ["A"] });
      const seen = (await (await h.post(`/api/alarms/dev/${id}/seen`)).json()) as { alarm: Alarm };
      expect(seen.alarm.state).toBe("seen");
      expect(h.routed).toEqual([]);
      const dismissed = await h.post(`/api/alarms/dev/${id}/dismiss`);
      expect(((await dismissed.json()) as { alarm: Alarm }).alarm.state).toBe("acknowledged");
      expect(h.routed).toHaveLength(1);
    } finally {
      await h.connector.stop();
    }
  });
});

describe("the WS push and the watching count (§22.3/§22.4)", () => {
  test("an open tab is watching; the whole slot is pushed, then null when resolved", async () => {
    const h = await harness();
    const events: { type: string; agent?: string; alarm?: Alarm | null }[] = [];
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${h.connector.port}/api/ws`, {
        headers: { cookie: `${SESSION_COOKIE}=${h.token}` },
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String(event.data)) as { type: string });
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const out = await h.hub.call("dev", { text: "help", level: 1 });
      expect(out.ok && out.watching).toBe(1);
      if (!out.ok) return;
      await h.post(`/api/alarms/dev/${out.id}/seen`); // no options ⇒ acknowledged
      const deadline = Date.now() + 5000;
      const alarmEvents = () => events.filter((event) => event.type === "alarm");
      while (alarmEvents().length < 2) {
        if (Date.now() > deadline) throw new Error("timeout waiting for the alarm pushes");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(alarmEvents()[0]?.alarm).toMatchObject({ id: out.id, state: "raised" });
      expect(alarmEvents()[1]).toEqual({ type: "alarm", agent: "dev", alarm: null });
      socket.close();
    } finally {
      await h.connector.stop();
    }
  });

  test("nobody with a tab open ⇒ watching 0 — the agent knows it is not heard", async () => {
    const h = await harness();
    try {
      const out = await h.hub.call("dev", { text: "help", level: 1 });
      expect(out.ok && out.watching).toBe(0);
    } finally {
      await h.connector.stop();
    }
  });
});
