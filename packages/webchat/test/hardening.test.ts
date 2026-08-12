// T51 adversarial pass (§12.6, FR-42): the leftover vectors beyond the per-task
// suites — malformed input never crashes the surface, sessions die with the
// process unless a durable store is wired (FR-57, session.test.ts), header
// injection via file names is neutralized, method scoping holds, and errors
// stay generic (no secrets, no paths — §8.7).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_COOKIE, type WebchatBlobStore, WebchatConnector } from "../src/connector";
import { HistoryStore } from "../src/history";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-hardening-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class MemoryBlobs implements WebchatBlobStore {
  readonly bytes = new Map<string, Uint8Array>();
  #seq = 0;
  async write(data: Uint8Array): Promise<string> {
    this.#seq += 1;
    const id = `blob-${this.#seq}`;
    this.bytes.set(id, data);
    return id;
  }
  async read(id: string): Promise<Uint8Array> {
    const found = this.bytes.get(id);
    if (found === undefined) throw new Error("refused");
    return found;
  }
}

async function startedConnector(
  overrides: Partial<ConstructorParameters<typeof WebchatConnector>[0]> = {},
): Promise<WebchatConnector> {
  const connector = new WebchatConnector({
    bindOperator: "operator-web",
    port: 0,
    password: "correct-horse",
    history: new HistoryStore({ dir: join(dir, "operator-web"), operator: "operator-web" }),
    blobs: new MemoryBlobs(),
    ...overrides,
  });
  await connector.start(async () => undefined);
  return connector;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://panel.test${path}`, {
    headers: { host: "panel.test", ...((init.headers as Record<string, string>) ?? {}) },
    ...init,
  });
}

const jsonPost = (path: string, body: string, headers: Record<string, string> = {}): Request =>
  request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

async function login(connector: WebchatConnector): Promise<string> {
  const response = await connector.handleRequest(
    jsonPost("/api/login", JSON.stringify({ password: "correct-horse" })),
  );
  const token = /muxeon_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (token === undefined) throw new Error("no session cookie");
  return `${SESSION_COOKIE}=${token}`;
}

describe("malformed input never crashes the surface (§12.6)", () => {
  // every malformed body is a plain refusal — the same 401 as a wrong password
  // (no shape oracle), and the secret never echoes (§8.7)
  test.each([
    ["not json at all"],
    ["[1,2,3]"],
    [JSON.stringify({ password: 42 })],
    [JSON.stringify({ password: null })],
    [JSON.stringify({})],
  ])("login body %j → 401, generic error", async (body) => {
    const connector = await startedConnector();
    try {
      const response = await connector.handleRequest(jsonPost("/api/login", body as string));
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).not.toContain("correct-horse");
      expect(text).not.toContain("stack");
    } finally {
      await connector.stop();
    }
  });

  test("a huge junk cookie header is just an auth failure", async () => {
    const connector = await startedConnector();
    try {
      const response = await connector.handleRequest(
        jsonPost("/api/send", JSON.stringify({ to: "a", text: "x", id: "i" }), {
          cookie: `${"x".repeat(8192)}; ${SESSION_COOKIE}=${"y".repeat(4096)}`,
        }),
      );
      expect(response.status).toBe(401);
    } finally {
      await connector.stop();
    }
  });
});

describe("sessions without a durable store are process-scoped (§12.6)", () => {
  // the FR-57 persistence is opt-in via `session.file` — none wired here, so
  // the pre-FR-57 guarantee still holds: a restart revokes everything
  test("a token from a previous connector instance is dead after a restart", async () => {
    const first = await startedConnector();
    const cookie = await login(first);
    await first.stop();
    const reborn = await startedConnector();
    try {
      const response = await reborn.handleRequest(
        jsonPost("/api/send", JSON.stringify({ to: "a", text: "x", id: "i" }), { cookie }),
      );
      expect(response.status).toBe(401);
    } finally {
      await reborn.stop();
    }
  });
});

describe("header injection via file names (§12.6/§8.7)", () => {
  test("a hostile filename cannot break out of Content-Disposition", async () => {
    // Seed the name through the durable metadata path (history, §12.5) — the
    // exact source a post-restart download trusts; multipart quirks aside, the
    // download sink itself must sanitize.
    const blobs = new MemoryBlobs();
    const history = new HistoryStore({
      dir: join(dir, "operator-web"),
      operator: "operator-web",
    });
    const id = await blobs.write(new TextEncoder().encode("bytes"));
    await history.append({
      id: "h-1",
      from: "operator-web",
      to: "researcher",
      kind: "message",
      ts: Date.now(),
      payload: {
        blobs: [{ blob: id, name: 'evil";\r\nSet-Cookie: pwned=1;.pdf', mime: "application/pdf" }],
      },
    });
    const connector = await startedConnector({ blobs, history });
    try {
      const cookie = await login(connector);
      const download = await connector.handleRequest(
        request(`/api/blobs/${id}`, { headers: { cookie } }),
      );
      expect(download.status).toBe(200);
      const disposition = download.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      expect(disposition).not.toContain('";');
      expect(disposition).not.toContain("\r");
      expect(disposition).not.toContain("Set-Cookie:");
      expect(download.headers.get("set-cookie")).toBeNull();
    } finally {
      await connector.stop();
    }
  });
});

describe("method scoping (§12.4 closed surface)", () => {
  test("wrong-method calls on every endpoint are 404/405, not handlers", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      expect(
        (await connector.handleRequest(request("/api/send", { headers: { cookie } }))).status,
      ).toBe(404); // GET send
      expect(
        (
          await connector.handleRequest(
            jsonPost("/api/peers", "{}", { cookie }), // POST peers
          )
        ).status,
      ).toBe(404);
      expect((await connector.handleRequest(request("/api/login", { headers: {} }))).status).toBe(
        405,
      ); // GET login
      expect(
        (
          await connector.handleRequest(
            request("/api/blobs/blob-1", { method: "DELETE", headers: { cookie } }),
          )
        ).status,
      ).toBe(404); // no delete surface exists
    } finally {
      await connector.stop();
    }
  });
});
