// T44 integration (§12, FR-38/FR-42): the webchat channel wired through
// bootstrap — its OWN listener next to server.port, the default factory path.
// System-level §10.12 guard: an unauthenticated request over the real wire
// leaves the agent queue untouched. Authenticated path: login → /api/send →
// router → dispatcher injects into the (fake) session. Outbound in T44 has no
// sink yet: a reply accumulates in the operator's pseudo-session (§10.9).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry, makeDefaultRender } from "@teamai/adapters";
import { bootstrap } from "../src/bootstrap";

// An unprivileged high port unlikely to collide; the suite runs sequentially.
const PANEL_PORT = 18090 + Math.floor(Math.random() * 1000);

let dir: string;
let injected: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-webchat-"));
  injected = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    // the production render path (T48): blob refs resolve under <root>/blobs/
    render: (message) => makeDefaultRender({ blobsDir: join(dir, "queue", "blobs") })(message),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

function writeConfig(channel: Record<string, unknown>): string {
  const configFile = join(dir, "teamai.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 8080, mcp: false, queueDir: "./queue" },
      agents: [
        { name: "researcher", type: "dummy", tmux: "researcher-s" },
        { name: "loner", type: "dummy", tmux: "loner-s" }, // no edge to the operator
      ],
      topology: { researcher: ["operator-web", "loner"] },
      channels: [channel],
    }),
  );
  return configFile;
}

async function boot(channelOverrides: Record<string, unknown> = {}) {
  return bootstrap({
    configFile: writeConfig({
      type: "webchat",
      bindOperator: "operator-web",
      port: PANEL_PORT,
      auth: { password: { $env: "TEAMAI_WEB_PASSWORD" } },
      ...channelOverrides,
    }),
    env: (name) => (name === "TEAMAI_WEB_PASSWORD" ? "hunter2" : undefined),
    registry: dummyRegistry(),
    probe: async () => true,
    makeDriver: () => ({
      inject: async (text: string) => {
        injected.push(text);
      },
      awaitTurn: async () => undefined,
    }),
    startRoutines: false,
  });
}

const api = (path: string): string => `http://127.0.0.1:${PANEL_PORT}${path}`;

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("webchat wiring (T44: §12, §10.12, FR-38/FR-42)", () => {
  test("login → send → routed → injected into the agent session; done/ archived (§10.8)", async () => {
    const server = await boot();
    try {
      expect([...server.channels.keys()]).toEqual(["operator-web"]);
      const login = await fetch(api("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const send = await fetch(api("/api/send"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ to: "researcher", text: "find bun docs", id: "m-1" }),
      });
      expect(send.status).toBe(200);
      // ≥1: the reply-less dummy agent also earns a FR-45 nudge injection.
      await waitFor(() => injected.length >= 1);
      expect(injected[0]).toContain("find bun docs");
      const done = join(dir, "queue", "researcher-s", "done");
      await waitFor(() => readdirSync(done).some((f) => f.endsWith(".json")));
    } finally {
      await server.stop();
    }
  });

  test("§10.12: an unauthenticated send over the wire never reaches the queue", async () => {
    const server = await boot();
    try {
      const response = await fetch(api("/api/send"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "researcher", text: "smuggled", id: "m-x" }),
      });
      expect(response.status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(injected).toHaveLength(0);
      const pending = join(dir, "queue", "researcher-s", "pending");
      const done = join(dir, "queue", "researcher-s", "done");
      expect(readdirSync(pending)).toHaveLength(0);
      expect(readdirSync(done).filter((f) => f.endsWith(".json"))).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  test("a reply to the operator lands in the durable history and completes to done/ (T45, §12.3)", async () => {
    const server = await boot();
    try {
      const result = await server.router.route({
        id: "reply-1",
        from: "researcher",
        to: "operator-web",
        kind: "message",
        ts: Date.now(),
        payload: "found three docs",
      });
      expect(result.ok).toBe(true);
      // deliver = history append (§12.3) — no browser connected, still done/
      const done = join(dir, "queue", "operator-web", "done");
      await waitFor(() => readdirSync(done).some((f) => f.endsWith(".json")));
      const log = join(dir, "webchat", "history", "operator-web", "researcher.jsonl");
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        id: "reply-1",
        from: "researcher",
        payload: "found three docs",
      });
    } finally {
      await server.stop();
    }
  });

  test("history retention joins the sweep: history.retain count cap prunes (§12.3/§5.4)", async () => {
    const server = await boot({ history: { retain: { count: 2 } } });
    try {
      for (let i = 0; i < 4; i += 1) {
        const result = await server.router.route({
          id: `r-${i}`,
          from: "researcher",
          to: "operator-web",
          kind: "message",
          ts: Date.now() + i,
          payload: `news ${i}`,
        });
        expect(result.ok).toBe(true);
      }
      const log = join(dir, "webchat", "history", "operator-web", "researcher.jsonl");
      // the inline count cap may trim during appends — wait for the last delivery
      await waitFor(() => {
        try {
          return readFileSync(log, "utf8").includes("r-3");
        } catch {
          return false;
        }
      });
      await server.retention.sweep();
      const ids = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { id: string }).id);
      expect(ids).toEqual(["r-2", "r-3"]); // double cap: newest 2 survive
    } finally {
      await server.stop();
    }
  });

  test("peers are the operator's topology neighbors — a no-edge agent is invisible (§10.2/FR-40)", async () => {
    const server = await boot();
    try {
      const login = await fetch(api("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const response = await fetch(api("/api/peers"), { headers: { cookie } });
      expect(response.status).toBe(200);
      const { peers } = (await response.json()) as {
        peers: { name: string; status: string }[];
      };
      expect(peers.map((p) => p.name)).toEqual(["researcher"]); // loner: no edge → invisible
      expect(peers[0]?.status).toBe("idle");
    } finally {
      await server.stop();
    }
  });

  test("WS feed end-to-end: reply push + send progress to done (§12.4/§12.7)", async () => {
    const server = await boot();
    try {
      const login = await fetch(api("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const events: { type: string; [key: string]: unknown }[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/api/ws`, {
        headers: { cookie },
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String(event.data)) as { type: string });
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });

      // an agent reply → pseudo-session → deliver → history + WS push
      await server.router.route({
        id: "ws-reply-1",
        from: "researcher",
        to: "operator-web",
        kind: "message",
        ts: Date.now(),
        payload: "live news",
      });
      await waitFor(() =>
        events.some(
          (e) => e.type === "message" && (e.record as { id: string }).id === "ws-reply-1",
        ),
      );

      // a send → ack now, queue-progress "done" once the dispatcher archives it
      const sent = await fetch(api("/api/send"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ to: "researcher", text: "track me", id: "ws-track-1" }),
      });
      expect(sent.status).toBe(200);
      await waitFor(() => events.some((e) => e.type === "ack" && e.id === "ws-track-1"));
      await waitFor(
        () =>
          events.some(
            (e) => e.type === "queue-progress" && e.id === "ws-track-1" && e.phase === "done",
          ),
        8000,
      );
      socket.close();
    } finally {
      await server.stop();
    }
  });

  test("media e2e: upload → send with blob ref → agent payload carries it → bytes download (T47/§12.5)", async () => {
    const server = await boot();
    try {
      const login = await fetch(api("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const form = new FormData();
      form.set("file", new File(["voice-note-bytes"], "note.webm", { type: "audio/webm" }));
      const uploaded = await fetch(api("/api/blobs"), {
        method: "POST",
        headers: { cookie },
        body: form,
      });
      expect(uploaded.status).toBe(200);
      const { id: blobId } = (await uploaded.json()) as { id: string };

      const sent = await fetch(api("/api/send"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ to: "researcher", text: "listen", blobs: [blobId], id: "m-blob" }),
      });
      expect(sent.status).toBe(200);
      await waitFor(() => injected.length >= 1); // ≥1: a FR-45 nudge may follow
      // T48 (FR-43): the agent received the blob as a RESOLVED LOCAL PATH it can read
      expect(injected[0]).toContain("listen");
      expect(injected[0]).toContain(`→ ${join(dir, "queue", "blobs", blobId)}`);
      const done = join(dir, "queue", "researcher-s", "done");
      await waitFor(() => readdirSync(done).some((f) => f.endsWith(".json")));
      const recordFile = readdirSync(done).find((f) => f.endsWith("-m-blob.json"));
      const record = JSON.parse(readFileSync(join(done, recordFile ?? ""), "utf8")) as {
        payload: { blobs: { blob: string; mime: string }[] };
      };
      // (Bun's multipart parser may re-derive the mime from the extension —
      // the invariant is: the ref is opaque and carries a webm media type.)
      expect(record.payload.blobs[0]?.blob).toBe(blobId);
      expect(record.payload.blobs[0]?.mime).toMatch(/\/webm$/);

      const download = await fetch(api(`/api/blobs/${blobId}`), { headers: { cookie } });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("voice-note-bytes");
      // and the real store's containment refuses traversal ids (§8.7/§10.11)
      const traversal = await fetch(api("/api/blobs/..%2F..%2Fteamai.config.json"), {
        headers: { cookie },
      });
      expect(traversal.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("the built SPA is served on the same port (T49, §12.7); APIs stay gated (§10.12)", async () => {
    const server = await boot();
    try {
      const shell = await fetch(api("/"));
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toContain("text/html");
      expect(await shell.text()).toContain("assets/main.js");
      const asset = await fetch(api("/assets/main.js"));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
      // SPA fallback for client routes; assets miss → 404; traversal → 404
      expect((await fetch(api("/some/client/route"))).status).toBe(200);
      expect((await fetch(api("/assets/ghost.js"))).status).toBe(404);
      expect((await fetch(api("/..%2F..%2Fteamai.config.json"))).status).toBe(404);
      // the public shell does NOT weaken the API gate
      expect((await fetch(api("/api/peers"))).status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  test("transport observability e2e: an agent↔agent route is visible in the panel (T64, FR-48)", async () => {
    const server = await boot();
    try {
      // agent → agent — invisible to the per-operator history, but routed
      const routed = await server.router.route({
        id: "a2a-1",
        from: "researcher",
        to: "loner",
        kind: "message",
        ts: Date.now(),
        payload: "peer to peer",
      });
      expect(routed.ok).toBe(true);
      // the router's onRouted append is fire-and-forget — wait for the line
      const logFile = join(dir, "queue", "observe", "transport.jsonl");
      await waitFor(() => {
        try {
          return readFileSync(logFile, "utf8").includes("a2a-1");
        } catch {
          return false;
        }
      });

      // unauthenticated → 401 (§10.12), nothing leaks
      expect((await fetch(api("/api/transport"))).status).toBe(401);

      const login = await fetch(api("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const response = await fetch(api("/api/transport"), { headers: { cookie } });
      expect(response.status).toBe(200);
      const { records } = (await response.json()) as {
        records: { id: string; from: string; to: string }[];
      };
      const a2a = records.find((record) => record.id === "a2a-1");
      expect(a2a).toMatchObject({ from: "researcher", to: "loner" });
    } finally {
      await server.stop();
    }
  });

  test("a session survives a full server restart (FR-57, §12.6)", async () => {
    // login on the first boot, restart the whole server, reuse the cookie: the
    // panel answers 200 without a re-login — the durable store under
    // <config_dir>/webchat/sessions/ carries the (hashed) token across.
    const first = await boot({
      auth: { password: { $env: "TEAMAI_WEB_PASSWORD" }, session: { ttl: "1d" } },
    });
    let cookie: string;
    try {
      const login = await fetch(api("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toContain("Max-Age=86400");
      cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    } finally {
      await first.stop();
    }
    const stored = readFileSync(join(dir, "webchat", "sessions", "operator-web.json"), "utf8");
    expect(stored).not.toContain(cookie.split("=")[1]); // hashes at rest, not tokens (§8.7)
    const reborn = await boot({
      auth: { password: { $env: "TEAMAI_WEB_PASSWORD" }, session: { ttl: "1d" } },
    });
    try {
      const peers = await fetch(api("/api/peers"), { headers: { cookie } });
      expect(peers.status).toBe(200);
    } finally {
      await reborn.stop();
    }
  });

  test("fail-fast: an invalid auth.session.ttl refuses to boot (§12.2/FR-57)", async () => {
    await expect(
      boot({ auth: { password: { $env: "TEAMAI_WEB_PASSWORD" }, session: { ttl: "soon" } } }),
    ).rejects.toThrow(/invalid auth\.session\.ttl/);
  });

  test("fail-fast: webchat port colliding with server.port refuses to boot (§12.2)", async () => {
    await expect(boot({ port: 8080 })).rejects.toThrow(/must differ from server\.port/);
  });

  test("fail-fast: a missing auth refuses to boot (§12.2)", async () => {
    await expect(boot({ auth: undefined })).rejects.toThrow(/auth\.password/);
  });

  test("fail-fast: an inline (non-$env) auth.password refuses to boot (§7.3)", async () => {
    await expect(boot({ auth: { password: "inline-secret" } })).rejects.toThrow(/\$env/);
  });

  test("fail-fast: defaultTarget on a webchat channel refuses to boot (§12.2)", async () => {
    await expect(boot({ defaultTarget: "researcher" })).rejects.toThrow(
      /does not use defaultTarget/,
    );
  });
});
