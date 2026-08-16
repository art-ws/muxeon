// WebchatConnector unit tests (T44, FR-38/FR-42, §12.4/§12.6). The §10.12 guard
// lives here at the package level: an unauthenticated request must be rejected
// BEFORE any core port (onInbound → router) is touched. The system-level guard
// (through bootstrap) is packages/server/test/webchat.test.ts.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouteRefusedError } from "@muxeon/channels";
import type { Message, Signal } from "@muxeon/core";
import { SESSION_COOKIE, WebchatConnector } from "../src/connector";
import { HistoryStore } from "../src/history";

let inbound: Message[];
let inboundError: Error | undefined;

function makeConnector(
  overrides: Partial<ConstructorParameters<typeof WebchatConnector>[0]> = {},
): WebchatConnector {
  return new WebchatConnector({
    bindOperator: "operator-web",
    port: 0,
    password: "hunter2",
    ...overrides,
  });
}

/** Started connector with an in-memory inbound spy (no listener — in-process fetch). */
async function startedConnector(
  overrides: Partial<ConstructorParameters<typeof WebchatConnector>[0]> = {},
): Promise<WebchatConnector> {
  const connector = makeConnector(overrides);
  await connector.start(async (message) => {
    if (inboundError !== undefined) throw inboundError;
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

async function login(connector: WebchatConnector, password = "hunter2"): Promise<string> {
  const response = await connector.handleRequest(post("/api/login", { password }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  const token = /muxeon_webchat=([^;]+)/.exec(cookie)?.[1];
  if (token === undefined) throw new Error("no session cookie issued");
  return token;
}

const asCookie = (token: string): Record<string, string> => ({
  cookie: `${SESSION_COOKIE}=${token}`,
});

beforeEach(() => {
  inbound = [];
  inboundError = undefined;
});

describe("auth gate (§10.12, §12.6)", () => {
  test("unauthenticated /api/send → 401 and the core port is NEVER touched", async () => {
    const connector = await startedConnector();
    const response = await connector.handleRequest(
      post("/api/send", { to: "researcher", text: "hi", id: "m-1" }),
    );
    expect(response.status).toBe(401);
    expect(inbound).toHaveLength(0); // §10.12: rejected before onInbound
  });

  test("a forged cookie is rejected the same way", async () => {
    const connector = await startedConnector();
    const response = await connector.handleRequest(
      post("/api/send", { to: "researcher", text: "hi", id: "m-1" }, asCookie("forged-token")),
    );
    expect(response.status).toBe(401);
    expect(inbound).toHaveLength(0);
  });

  test("wrong password → 401, no cookie", async () => {
    const connector = await startedConnector();
    const response = await connector.handleRequest(post("/api/login", { password: "nope" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("login is rate-limited before the password compare (§12.6)", async () => {
    const connector = await startedConnector({
      loginRate: { maxAttempts: 3, windowMs: 60_000, now: () => 1000 },
    });
    for (let i = 0; i < 3; i += 1) {
      const probe = await connector.handleRequest(post("/api/login", { password: "guess" }));
      expect(probe.status).toBe(401);
    }
    // over the limit: even the RIGHT password is refused within the window
    const overLimit = await connector.handleRequest(post("/api/login", { password: "hunter2" }));
    expect(overLimit.status).toBe(429);
  });

  test("the rate-limit window slides with time", async () => {
    let now = 1000;
    const connector = await startedConnector({
      loginRate: { maxAttempts: 2, windowMs: 60_000, now: () => now },
    });
    await connector.handleRequest(post("/api/login", { password: "a" }));
    await connector.handleRequest(post("/api/login", { password: "b" }));
    expect(
      (await connector.handleRequest(post("/api/login", { password: "hunter2" }))).status,
    ).toBe(429);
    now += 60_000; // a fresh window
    expect(
      (await connector.handleRequest(post("/api/login", { password: "hunter2" }))).status,
    ).toBe(200);
  });

  test("Secure cookie flag appears only behind a TLS proxy (x-forwarded-proto)", async () => {
    const connector = await startedConnector();
    const plain = await connector.handleRequest(post("/api/login", { password: "hunter2" }));
    expect(plain.headers.get("set-cookie")).not.toContain("Secure");
    const proxied = await connector.handleRequest(
      post("/api/login", { password: "hunter2" }, { "x-forwarded-proto": "https" }),
    );
    expect(proxied.headers.get("set-cookie")).toContain("; Secure");
    expect(proxied.headers.get("set-cookie")).toContain("HttpOnly");
    expect(proxied.headers.get("set-cookie")).toContain("SameSite=Lax");
  });
});

describe("logout (T91, FR-68)", () => {
  const getPeers = (token: string): Request =>
    new Request("http://panel.test/api/peers", {
      headers: { host: "panel.test", ...asCookie(token) },
    });

  test("logout revokes the session SERVER-SIDE and expires the cookie", async () => {
    const connector = await startedConnector();
    const token = await login(connector);
    expect((await connector.handleRequest(getPeers(token))).status).toBe(200);
    const out = await connector.handleRequest(post("/api/logout", {}, asCookie(token)));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    // the SAME token is dead afterwards — revoked in the store, not just the browser
    expect((await connector.handleRequest(getPeers(token))).status).toBe(401);
  });

  test("logout itself sits behind the auth gate (§10.12)", async () => {
    const connector = await startedConnector();
    expect((await connector.handleRequest(post("/api/logout", {}))).status).toBe(401);
  });

  test("peers payload names the bound operator — the account button (FR-68)", async () => {
    const connector = await startedConnector();
    const token = await login(connector);
    const body = (await (await connector.handleRequest(getPeers(token))).json()) as {
      operator?: string;
    };
    expect(body.operator).toBe("operator-web");
  });
});

describe("CSRF Origin check (§12.6)", () => {
  test("a cross-origin POST is rejected for every endpoint, login included", async () => {
    const connector = await startedConnector();
    const response = await connector.handleRequest(
      post("/api/login", { password: "hunter2" }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    const token = await login(connector);
    const send = await connector.handleRequest(
      post(
        "/api/send",
        { to: "researcher", text: "hi", id: "m-1" },
        { ...asCookie(token), origin: "https://evil.example" },
      ),
    );
    expect(send.status).toBe(403);
    expect(inbound).toHaveLength(0);
  });

  test("a same-origin POST passes (host or x-forwarded-host match)", async () => {
    const connector = await startedConnector();
    const direct = await connector.handleRequest(
      post("/api/login", { password: "hunter2" }, { origin: "http://panel.test" }),
    );
    expect(direct.status).toBe(200);
    const proxied = await connector.handleRequest(
      post(
        "/api/login",
        { password: "hunter2" },
        { origin: "https://team.example.com", "x-forwarded-host": "team.example.com" },
      ),
    );
    expect(proxied.status).toBe(200);
  });
});

describe("POST /api/send (§12.4, FR-38)", () => {
  test("authenticated text send → Message through onInbound, client id preserved (§10.9)", async () => {
    const connector = await startedConnector({ now: () => 1234 });
    const token = await login(connector);
    const response = await connector.handleRequest(
      post("/api/send", { to: "researcher", text: "find bun docs", id: "m-42" }, asCookie(token)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: true, id: "m-42", to: "researcher" });
    expect(inbound).toEqual([
      {
        id: "m-42",
        from: "operator-web",
        to: "researcher",
        kind: "message",
        ts: 1234,
        payload: "find bun docs",
        origin: "webchat",
      },
    ]);
  });

  test.each([
    [{ text: "hi", id: "m-1" }, '"to"'],
    [{ to: "researcher", id: "m-1" }, '"text"'],
    [{ to: "researcher", text: "hi" }, '"id"'],
  ])("missing field → 400, core untouched: %j", async (body, field) => {
    const connector = await startedConnector();
    const token = await login(connector);
    const response = await connector.handleRequest(post("/api/send", body, asCookie(token)));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(field);
    expect(inbound).toHaveLength(0);
  });

  test("raw mode (FR-88, §14.3): the `raw` flag rides the Message through onInbound", async () => {
    const connector = await startedConnector({ now: () => 7 });
    const token = await login(connector);
    const response = await connector.handleRequest(
      post(
        "/api/send",
        { to: "researcher", text: "ls -la", id: "m-raw", raw: true },
        asCookie(token),
      ),
    );
    expect(response.status).toBe(200);
    expect(inbound[0]).toEqual({
      id: "m-raw",
      from: "operator-web",
      to: "researcher",
      kind: "message",
      ts: 7,
      payload: "ls -la",
      origin: "webchat",
      raw: true,
    });
  });

  test("raw mode rejects attachments and requires text (§14.3)", async () => {
    const connector = await startedConnector();
    const token = await login(connector);
    const withBlobs = await connector.handleRequest(
      post(
        "/api/send",
        { to: "researcher", text: "x", blobs: ["b1"], id: "m-1", raw: true },
        asCookie(token),
      ),
    );
    expect(withBlobs.status).toBe(400);
    expect(((await withBlobs.json()) as { error: string }).error).toContain("attachments");
    const noText = await connector.handleRequest(
      post("/api/send", { to: "researcher", id: "m-2", raw: true }, asCookie(token)),
    );
    expect(noText.status).toBe(400);
    expect(((await noText.json()) as { error: string }).error).toContain("raw mode");
    expect(inbound).toHaveLength(0); // never reached the core
  });

  test("a route refusal surfaces as a clear operator error (§3.2/§10.2)", async () => {
    const connector = await startedConnector();
    const token = await login(connector);
    inboundError = new RouteRefusedError("TOPOLOGY_DENIED", "loner");
    const response = await connector.handleRequest(
      post("/api/send", { to: "loner", text: "hi", id: "m-1" }, asCookie(token)),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain(
      'cannot deliver to "loner"',
    );
  });

  test("any other inbound failure stays generic (no internals leak, §8.7)", async () => {
    const connector = await startedConnector();
    const token = await login(connector);
    inboundError = new Error("ENOENT /secret/path/pending");
    const response = await connector.handleRequest(
      post("/api/send", { to: "researcher", text: "hi", id: "m-1" }, asCookie(token)),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe("muxeon: delivery failed");
  });
});

describe("deliver → history (§12.3, §10.9, FR-39)", () => {
  const signal: Signal = {
    id: "s-1",
    from: "researcher",
    to: "operator-web",
    kind: "message",
    ts: 1,
    payload: "news",
  };

  test("without a history store it throws — the record stays queued", async () => {
    const connector = makeConnector();
    await expect(connector.deliver(signal)).rejects.toThrow(/history is not wired/);
  });

  test("the history append IS the delivery — no browser required; dup id = no-op success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muxeon-webchat-hist-"));
    try {
      const history = new HistoryStore({ dir, operator: "operator-web" });
      const delivered: Signal[] = [];
      const connector = makeConnector({ history, onDelivered: (s) => delivered.push(s) });
      await connector.deliver(signal);
      await connector.deliver(signal); // duplicate push (at-least-once §10.9)
      expect((await history.page("researcher")).records).toEqual([signal]);
      expect(delivered).toEqual([signal]); // the WS hook fires once, not per dup
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an authenticated send is mirrored into the history (outbound side, §12.3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muxeon-webchat-hist-"));
    try {
      const history = new HistoryStore({ dir, operator: "operator-web" });
      const connector = await startedConnector({ history, now: () => 7 });
      const token = await login(connector);
      await connector.handleRequest(
        post("/api/send", { to: "researcher", text: "hello", id: "m-7" }, asCookie(token)),
      );
      const page = await history.page("researcher");
      expect(page.records.map((r) => ({ id: r.id, from: r.from }))).toEqual([
        { id: "m-7", from: "operator-web" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listener lifecycle", () => {
  test("start binds the port (ephemeral 0 for tests), a real round-trip works, stop closes", async () => {
    const connector = await startedConnector();
    try {
      expect(connector.port).toBeGreaterThan(0);
      const unauth = await fetch(`http://127.0.0.1:${connector.port}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "researcher", text: "hi", id: "m-1" }),
      });
      expect(unauth.status).toBe(401); // §10.12 over the real wire too
      expect(inbound).toHaveLength(0);
      await expect(connector.start(async () => {})).rejects.toThrow(/already started/);
    } finally {
      await connector.stop();
    }
  });

  test("non-/api paths 404 until the SPA mounts (T49)", async () => {
    const connector = await startedConnector();
    const response = await connector.handleRequest(
      new Request("http://panel.test/", { method: "GET" }),
    );
    expect(response.status).toBe(404);
  });
});

// --- instance label injection into the SPA shell (FR-90, §12.7) -----------------

describe("instance label injection (FR-90)", () => {
  const SHELL =
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n' +
    '    <title>Muxeon</title>\n  </head>\n  <body><div id="root"></div>' +
    '<script type="module" src="./assets/main.js"></script></body>\n</html>\n';

  async function withShell(
    instanceName: string | undefined,
    run: (connector: WebchatConnector) => Promise<void>,
  ): Promise<void> {
    const staticDir = mkdtempSync(join(tmpdir(), "muxeon-webchat-ui-"));
    try {
      await Bun.write(join(staticDir, "index.html"), SHELL);
      await Bun.write(join(staticDir, "assets", "main.js"), "console.log(1)");
      const connector = await startedConnector({
        staticDir,
        ...(instanceName !== undefined ? { instanceName } : {}),
      });
      try {
        await run(connector);
      } finally {
        await connector.stop();
      }
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  }

  const get = (path: string): Request => new Request(`http://panel.test${path}`, { method: "GET" });

  test("the shell carries the name in the title and a meta the topbar reads", async () => {
    await withShell("prod-cluster", async (connector) => {
      const response = await connector.handleRequest(get("/"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("<title>prod-cluster - Muxeon</title>");
      expect(html).toContain('<meta name="muxeon-name" content="prod-cluster" />');
      expect(html).not.toContain("<title>Muxeon</title>");
    });
  });

  test("no instanceName ⇒ the shell is served verbatim (title stays Muxeon)", async () => {
    await withShell(undefined, async (connector) => {
      const html = await (await connector.handleRequest(get("/"))).text();
      expect(html).toContain("<title>Muxeon</title>");
      expect(html).not.toContain("muxeon-name");
    });
  });

  test("the label is HTML-escaped — it cannot break out of the title/meta (§12.6)", async () => {
    await withShell('<b>&"x', async (connector) => {
      const html = await (await connector.handleRequest(get("/"))).text();
      expect(html).toContain("<title>&lt;b&gt;&amp;&quot;x - Muxeon</title>");
      expect(html).toContain('content="&lt;b&gt;&amp;&quot;x"');
      expect(html).not.toContain("<b>"); // the raw tag never reaches the document
    });
  });

  test("the SPA fallback (extension-less route) is branded too", async () => {
    await withShell("prod-cluster", async (connector) => {
      const html = await (await connector.handleRequest(get("/transport"))).text();
      expect(html).toContain("<title>prod-cluster - Muxeon</title>");
    });
  });

  test("non-shell assets are streamed as-is, never branded", async () => {
    await withShell("prod-cluster", async (connector) => {
      const js = await (await connector.handleRequest(get("/assets/main.js"))).text();
      expect(js).toBe("console.log(1)");
    });
  });
});

// --- server build info endpoint (FR-91) ----------------------------------------

describe("server info endpoint (FR-91)", () => {
  const getServer = (token?: string): Request =>
    new Request("http://panel.test/api/server", {
      headers: { host: "panel.test", ...(token !== undefined ? asCookie(token) : {}) },
    });

  test("GET /api/server is behind the auth gate (§10.12)", async () => {
    const connector = await startedConnector({ serverInfo: { version: "1.2.3" } });
    expect((await connector.handleRequest(getServer())).status).toBe(401);
  });

  test("an authed read returns the build info verbatim", async () => {
    const info = { version: "1.2.3", commit: "78363b1", builtAt: "2026-06-09T20:45:05Z" };
    const connector = await startedConnector({ serverInfo: info });
    const token = await login(connector);
    const response = await connector.handleRequest(getServer(token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(info);
  });

  test("no build info wired ⇒ 503 (the panel then shows no footer)", async () => {
    const connector = await startedConnector();
    const token = await login(connector);
    expect((await connector.handleRequest(getServer(token))).status).toBe(503);
  });
});

// --- session info + renewal endpoints (T125, FR-86) ----------------------------

describe("session endpoints (FR-86)", () => {
  test("login reports expiresAt; GET /api/session repeats it after a 'reload'", async () => {
    const now = 1000;
    const connector = await startedConnector({ now: () => now, session: { ttlMs: 10_000 } });
    const loginResponse = await connector.handleRequest(
      post("/api/login", { password: "hunter2" }),
    );
    const body = (await loginResponse.json()) as { expiresAt?: number };
    expect(body.expiresAt).toBe(11_000);
    const token =
      /muxeon_webchat=([^;]+)/.exec(loginResponse.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const info = await connector.handleRequest(
      new Request("http://panel.test/api/session", {
        headers: { host: "panel.test", ...asCookie(token) },
      }),
    );
    expect(((await info.json()) as { expiresAt?: number }).expiresAt).toBe(11_000);
  });

  test("POST /api/session/renew slides the expiry and re-issues the cookie with the renew window", async () => {
    let now = 1000;
    const connector = await startedConnector({
      now: () => now,
      session: { ttlMs: 10_000, renewMs: 60_000 },
    });
    const token = await login(connector);
    now = 9_000;
    const renewed = await connector.handleRequest(post("/api/session/renew", {}, asCookie(token)));
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { expiresAt?: number }).expiresAt).toBe(69_000);
    const cookie = renewed.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=${token}`); // the SAME token
    expect(cookie).toContain("Max-Age=60"); // renewMs, seconds
    now = 50_000; // far past the original ttl — the renewed session is alive
    const peers = await connector.handleRequest(
      new Request("http://panel.test/api/peers", {
        headers: { host: "panel.test", ...asCookie(token) },
      }),
    );
    expect(peers.status).toBe(200);
  });

  test("both endpoints sit behind the auth gate (§10.12); an expired token cannot renew itself", async () => {
    let now = 1000;
    const connector = await startedConnector({ now: () => now, session: { ttlMs: 10_000 } });
    expect(
      (await connector.handleRequest(new Request("http://panel.test/api/session"))).status,
    ).toBe(401);
    expect((await connector.handleRequest(post("/api/session/renew", {}))).status).toBe(401);
    const token = await login(connector);
    now = 20_000; // expired
    expect(
      (await connector.handleRequest(post("/api/session/renew", {}, asCookie(token)))).status,
    ).toBe(401);
  });
});

// --- history export + clear (FR-84, §12.3) ------------------------------------

describe("history export + clear (FR-84)", () => {
  function withHistory() {
    const dir = mkdtempSync(join(tmpdir(), "muxeon-webchat-hist-"));
    const history = new HistoryStore({ dir, operator: "operator-web" });
    return { dir, history };
  }

  test("export downloads the peer's FULL log as a JSON attachment", async () => {
    const { dir, history } = withHistory();
    try {
      const connector = await startedConnector({ history, now: () => 7_000 });
      await connector.deliver({
        id: "e-1",
        from: "researcher",
        to: "operator-web",
        kind: "message",
        ts: 5,
        payload: "hello",
      });
      const token = await login(connector);
      const response = await connector.handleRequest(
        new Request("http://panel.test/api/history/researcher/export", {
          headers: { host: "panel.test", ...asCookie(token) },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="chat-researcher-1970-01-01.json"',
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.format).toBe("muxeon-chat-history");
      expect(body.operator).toBe("operator-web");
      expect(body.peer).toBe("researcher");
      expect((body.records as { id: string }[]).map((r) => r.id)).toEqual(["e-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clear drops the log, answers ok and pushes history-cleared (§12.4)", async () => {
    const { dir, history } = withHistory();
    try {
      const connector = await startedConnector({ history });
      await connector.deliver({
        id: "k-1",
        from: "researcher",
        to: "operator-web",
        kind: "message",
        ts: Date.now(),
        payload: "wipe me",
      });
      const token = await login(connector);
      const cleared = await connector.handleRequest(
        post("/api/history/researcher/clear", {}, asCookie(token)),
      );
      expect(cleared.status).toBe(200);
      const page = await connector.handleRequest(
        new Request("http://panel.test/api/history/researcher", {
          headers: { host: "panel.test", ...asCookie(token) },
        }),
      );
      expect(((await page.json()) as { records: unknown[] }).records).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both sit behind the auth gate (§10.12); a peer named like the action still pages", async () => {
    const { dir, history } = withHistory();
    try {
      const connector = await startedConnector({ history });
      const exportNoAuth = await connector.handleRequest(
        new Request("http://panel.test/api/history/researcher/export"),
      );
      expect(exportNoAuth.status).toBe(401);
      expect(
        (await connector.handleRequest(post("/api/history/researcher/clear", {}))).status,
      ).toBe(401);
      // "/api/history/export" has ONE segment — it is the peer "export", not a sub-route
      const token = await login(connector);
      const page = await connector.handleRequest(
        new Request("http://panel.test/api/history/export", {
          headers: { host: "panel.test", ...asCookie(token) },
        }),
      );
      expect(((await page.json()) as { records: unknown[] }).records).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- basePath mount (T120, §12.2) --------------------------------------------
// The whole surface — statics, /api, WS — exists only under the prefix; the SPA
// is prefix-agnostic (relative URLs, §12.6), so this server side IS the feature.

describe("basePath mount (T120, §12.2)", () => {
  test('"<prefix>" redirects to "<prefix>/" — relative SPA URLs resolve only from the slashed form', async () => {
    const connector = await startedConnector({ basePath: "/team" });
    const response = await connector.handleRequest(
      new Request("http://panel.test/team", { method: "GET" }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/team/");
  });

  test("outside the prefix there is NO surface — root paths 404, core ports untouched", async () => {
    const connector = await startedConnector({ basePath: "/team" });
    for (const path of ["/", "/api/peers", "/teamX/api/peers", "/team2/"]) {
      const response = await connector.handleRequest(
        new Request(`http://panel.test${path}`, { method: "GET" }),
      );
      expect(response.status).toBe(404);
    }
    const rootLogin = await connector.handleRequest(post("/api/login", { password: "hunter2" }));
    expect(rootLogin.status).toBe(404); // login included: the gate is before every route
    const rootSend = await connector.handleRequest(
      post("/api/send", { to: "researcher", text: "hi", id: "m-1" }),
    );
    expect(rootSend.status).toBe(404);
    expect(inbound).toHaveLength(0);
  });

  test("under the prefix the full surface works; the session cookie is scoped to it", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "muxeon-webchat-ui-"));
    try {
      await Bun.write(join(staticDir, "index.html"), "<html>shell</html>");
      await Bun.write(join(staticDir, "assets", "main.js"), "console.log(1)");
      const connector = await startedConnector({ basePath: "/team", staticDir });

      const loginResponse = await connector.handleRequest(
        post("/team/api/login", { password: "hunter2" }),
      );
      expect(loginResponse.status).toBe(200);
      const cookie = loginResponse.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("Path=/team"); // panels under one host don't share sessions
      const token = /muxeon_webchat=([^;]+)/.exec(cookie)?.[1] ?? "";

      const sent = await connector.handleRequest(
        post("/team/api/send", { to: "researcher", text: "hi", id: "m-1" }, asCookie(token)),
      );
      expect(sent.status).toBe(200);
      expect(inbound.map((m) => m.id)).toEqual(["m-1"]);

      // statics: the shell, an asset, and the SPA fallback — all prefix-stripped
      for (const path of ["/team/", "/team/deep-link"]) {
        const page = await connector.handleRequest(
          new Request(`http://panel.test${path}`, { method: "GET" }),
        );
        expect(page.status).toBe(200);
        expect(await page.text()).toBe("<html>shell</html>");
      }
      const asset = await connector.handleRequest(
        new Request("http://panel.test/team/assets/main.js", { method: "GET" }),
      );
      expect(asset.status).toBe(200);

      const logout = await connector.handleRequest(post("/team/api/logout", {}, asCookie(token)));
      expect(logout.headers.get("set-cookie")).toContain("Path=/team");
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  test("the WS upgrade lives under the prefix only (live listener)", async () => {
    const connector = await startedConnector({ basePath: "/team" });
    try {
      const loginResponse = await connector.handleRequest(
        post("/team/api/login", { password: "hunter2" }),
      );
      const token = /muxeon_webchat=([^;]+)/.exec(
        loginResponse.headers.get("set-cookie") ?? "",
      )?.[1];
      const rootWs = await fetch(`http://127.0.0.1:${connector.port}/api/ws`);
      expect(rootWs.status).toBe(404); // not a WS path anymore — plain out-of-prefix 404
      const socket = new WebSocket(`ws://127.0.0.1:${connector.port}/team/api/ws`, {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      socket.close();
    } finally {
      await connector.stop();
    }
  });
});

// --- lifecycle endpoints (T85, FR-65, §10.12) --------------------------------

describe("lifecycle endpoints (FR-65)", () => {
  function fakeLifecycle() {
    const calls: string[] = [];
    return {
      calls,
      port: {
        actions: (name: string) => ({ shutdown: name !== "down-agent", reload: true }),
        shutdown: async (name: string) => {
          calls.push(`shutdown:${name}`);
          return "down" as const;
        },
        reload: async (name: string) => {
          calls.push(`reload:${name}`);
          return "idle" as const;
        },
        commands: () => ["clear", "usage"],
        runCommand: async (name: string, slash: string) => {
          calls.push(`command:${name}:${slash}`);
          if (slash === "explode") throw new Error('command "/explode" is not configured');
          return "raw console output";
        },
        screen: async (name: string) => {
          calls.push(`screen:${name}`);
          if (name === "gone") throw new Error("no session");
          return "$ tail -f log\nline one\nline two";
        },
      },
    };
  }
  const ports = {
    listPeers: () => ["researcher"],
    peerStatus: () => "idle" as const,
    queueDepth: async () => 0,
    messagePhase: async () => undefined,
  };

  test("unauthenticated action → 401, the lifecycle port is NEVER touched (§10.12)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const response = await connector.handleRequest(post("/api/agents/researcher/shutdown", {}));
      expect(response.status).toBe(401);
      expect(fake.calls).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("shutdown/reload of a NEIGHBOR delegate to the port", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const shutdown = await connector.handleRequest(
        post("/api/agents/researcher/shutdown", {}, asCookie(token)),
      );
      expect(shutdown.status).toBe(200);
      expect(await shutdown.json()).toEqual({ ok: true, status: "down" });
      const reload = await connector.handleRequest(
        post("/api/agents/researcher/reload", {}, asCookie(token)),
      );
      expect(await reload.json()).toEqual({ ok: true, status: "idle" });
      expect(fake.calls).toEqual(["shutdown:researcher", "reload:researcher"]);
    } finally {
      await connector.stop();
    }
  });

  test("a NON-neighbor agent is 404 — the panel cannot reach past its topology (§10.2)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        post("/api/agents/loner/shutdown", {}, asCookie(token)),
      );
      expect(response.status).toBe(404);
      expect(fake.calls).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("an unknown action is 404; an unwired port is 503", async () => {
    const fake = fakeLifecycle();
    const wired = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(wired);
      expect(
        (await wired.handleRequest(post("/api/agents/researcher/explode", {}, asCookie(token))))
          .status,
      ).toBe(404);
    } finally {
      await wired.stop();
    }
    const bare = await startedConnector({ ports });
    try {
      const token = await login(bare);
      expect(
        (await bare.handleRequest(post("/api/agents/researcher/shutdown", {}, asCookie(token))))
          .status,
      ).toBe(503);
    } finally {
      await bare.stop();
    }
  });

  test("a port failure surfaces as a 409 operator error", async () => {
    const fake = fakeLifecycle();
    fake.port.shutdown = async () => {
      throw new Error("no provision block");
    };
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        post("/api/agents/researcher/shutdown", {}, asCookie(token)),
      );
      expect(response.status).toBe(409);
    } finally {
      await connector.stop();
    }
  });

  test("peers carry the available actions (FR-65)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        new Request("http://panel.test/api/peers", {
          headers: { host: "panel.test", ...asCookie(token) },
        }),
      );
      const body = (await response.json()) as { peers: { name: string; actions?: unknown }[] };
      expect(body.peers[0]?.actions).toEqual({ shutdown: true, reload: true });
    } finally {
      await connector.stop();
    }
  });
});

// --- console TEXT capture endpoint (FR-102, §12.4) ---------------------------

describe("screen capture endpoint (FR-102)", () => {
  function fakeLifecycle() {
    const calls: string[] = [];
    return {
      calls,
      port: {
        actions: () => ({ shutdown: true, reload: true }),
        shutdown: async () => "down" as const,
        reload: async () => "idle" as const,
        commands: () => ["clear"],
        runCommand: async () => "",
        screen: async (name: string) => {
          calls.push(`screen:${name}`);
          if (name === "gone") throw new Error("no session");
          return "$ tail -f log\nline one\nline two";
        },
      },
    };
  }
  const ports = {
    listPeers: () => ["researcher"],
    peerStatus: () => "idle" as const,
    queueDepth: async () => 0,
    messagePhase: async () => undefined,
  };
  const get = (path: string, headers: Record<string, string> = {}): Request =>
    new Request(`http://panel.test${path}`, { headers: { host: "panel.test", ...headers } });

  test("a NEIGHBOR's screen is captured and returned as-is", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/researcher/screen", asCookie(token)),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        output: "$ tail -f log\nline one\nline two",
      });
      expect(fake.calls).toEqual(["screen:researcher"]);
    } finally {
      await connector.stop();
    }
  });

  test("unauthenticated screen → 401, the port is NEVER touched (§10.12)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const response = await connector.handleRequest(get("/api/agents/researcher/screen"));
      expect(response.status).toBe(401);
      expect(fake.calls).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("a NON-neighbor screen is 404 — the panel cannot reach past its topology (§10.2)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/loner/screen", asCookie(token)),
      );
      expect(response.status).toBe(404);
      expect(fake.calls).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("a capture failure surfaces as a 409 operator error", async () => {
    const fake = fakeLifecycle();
    const withGone = { ...ports, listPeers: () => ["researcher", "gone"] };
    const connector = await startedConnector({ ports: withGone, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/gone/screen", asCookie(token)),
      );
      expect(response.status).toBe(409);
    } finally {
      await connector.stop();
    }
  });

  test("a port without a screen method answers 503", async () => {
    const noScreen = {
      actions: () => ({ shutdown: true, reload: true }),
      shutdown: async () => "down" as const,
      reload: async () => "idle" as const,
      commands: () => [],
      runCommand: async () => "",
    };
    const connector = await startedConnector({ ports, lifecycle: noScreen });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/researcher/screen", asCookie(token)),
      );
      expect(response.status).toBe(503);
    } finally {
      await connector.stop();
    }
  });
});

describe("token usage endpoint (§12.8, FR-103)", () => {
  const series = {
    minutes: [{ t: 1000, tokens: 42 }],
    hours: [{ t: 0, tokens: 100 }],
    current: 42,
    updatedAt: 1000,
    maxThreshold: 1_000_000,
  };
  const ports = {
    listPeers: () => ["researcher"],
    peerStatus: () => "idle" as const,
    queueDepth: async () => 0,
    messagePhase: async () => undefined,
    tokenSeries: (name: string) => (name === "researcher" ? series : undefined),
  };
  const get = (path: string, headers: Record<string, string> = {}): Request =>
    new Request(`http://panel.test${path}`, { headers: { host: "panel.test", ...headers } });

  test("a NEIGHBOR's token series is returned", async () => {
    const connector = await startedConnector({ ports });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/researcher/tokens", asCookie(token)),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, series });
    } finally {
      await connector.stop();
    }
  });

  test("unauthenticated → 401, the port is NEVER touched (§10.12)", async () => {
    let touched = false;
    const spy = {
      ...ports,
      tokenSeries: (name: string) => {
        touched = true;
        return name === "researcher" ? series : undefined;
      },
    };
    const connector = await startedConnector({ ports: spy });
    try {
      const response = await connector.handleRequest(get("/api/agents/researcher/tokens"));
      expect(response.status).toBe(401);
      expect(touched).toBe(false);
    } finally {
      await connector.stop();
    }
  });

  test("a NON-neighbor is 404 — no reach past topology (§10.2)", async () => {
    const connector = await startedConnector({ ports });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/loner/tokens", asCookie(token)),
      );
      expect(response.status).toBe(404);
    } finally {
      await connector.stop();
    }
  });

  test("a neighbor whose type has no tracking → 404", async () => {
    const withUntracked = { ...ports, listPeers: () => ["researcher", "plain"] };
    const connector = await startedConnector({ ports: withUntracked });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/plain/tokens", asCookie(token)),
      );
      expect(response.status).toBe(404);
    } finally {
      await connector.stop();
    }
  });

  test("a port without tokenSeries answers 503", async () => {
    const noTokens = {
      listPeers: () => ["researcher"],
      peerStatus: () => "idle" as const,
      queueDepth: async () => 0,
      messagePhase: async () => undefined,
    };
    const connector = await startedConnector({ ports: noTokens });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        get("/api/agents/researcher/tokens", asCookie(token)),
      );
      expect(response.status).toBe(503);
    } finally {
      await connector.stop();
    }
  });
});

describe("slash-command endpoint (T86, FR-66)", () => {
  function fakeLifecycle() {
    const calls: string[] = [];
    return {
      calls,
      port: {
        actions: () => ({ shutdown: true, reload: true }),
        shutdown: async () => "down" as const,
        reload: async () => "idle" as const,
        commands: () => ["clear", "usage"],
        runCommand: async (name: string, slash: string) => {
          calls.push(`command:${name}:${slash}`);
          if (slash === "exit") throw new Error('command "/exit" is not configured');
          return "  raw pane\n  output ✳ as-is";
        },
      },
    };
  }
  const ports = {
    listPeers: () => ["researcher"],
    peerStatus: () => "idle" as const,
    queueDepth: async () => 0,
    messagePhase: async () => undefined,
  };

  test("a configured command runs and returns the console output as-is", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        post("/api/agents/researcher/command", { slash: "usage" }, asCookie(token)),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, output: "  raw pane\n  output ✳ as-is" });
      expect(fake.calls).toEqual(["command:researcher:usage"]);
    } finally {
      await connector.stop();
    }
  });

  test("unauthenticated command → 401, the port is NEVER touched (§10.12)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const response = await connector.handleRequest(
        post("/api/agents/researcher/command", { slash: "usage" }),
      );
      expect(response.status).toBe(401);
      expect(fake.calls).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("a missing slash is 400; an unconfigured command surfaces as 409", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      expect(
        (await connector.handleRequest(post("/api/agents/researcher/command", {}, asCookie(token))))
          .status,
      ).toBe(400);
      expect(
        (
          await connector.handleRequest(
            post("/api/agents/researcher/command", { slash: "exit" }, asCookie(token)),
          )
        ).status,
      ).toBe(409);
    } finally {
      await connector.stop();
    }
  });

  test("a non-neighbor is 404 before the port (§10.2)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        post("/api/agents/loner/command", { slash: "usage" }, asCookie(token)),
      );
      expect(response.status).toBe(404);
      expect(fake.calls).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("peers carry the command list (FR-66)", async () => {
    const fake = fakeLifecycle();
    const connector = await startedConnector({ ports, lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        new Request("http://panel.test/api/peers", {
          headers: { host: "panel.test", ...asCookie(token) },
        }),
      );
      const body = (await response.json()) as { peers: { commands?: readonly string[] }[] };
      expect(body.peers[0]?.commands).toEqual(["clear", "usage"]);
    } finally {
      await connector.stop();
    }
  });

  test("peers carry the configured color (FR-73); absent when unconfigured", async () => {
    const colored = {
      ...ports,
      listPeers: () => ["researcher", "writer"],
      peerColor: (name: string) => (name === "researcher" ? "#ff8800" : undefined),
    };
    const connector = await startedConnector({ ports: colored });
    try {
      const token = await login(connector);
      const response = await connector.handleRequest(
        new Request("http://panel.test/api/peers", {
          headers: { host: "panel.test", ...asCookie(token) },
        }),
      );
      const body = (await response.json()) as { peers: { name: string; color?: string }[] };
      expect(body.peers.find((peer) => peer.name === "researcher")?.color).toBe("#ff8800");
      expect("color" in (body.peers.find((peer) => peer.name === "writer") ?? {})).toBe(false);
    } finally {
      await connector.stop();
    }
  });
});
