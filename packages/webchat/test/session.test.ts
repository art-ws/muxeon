// Durable TTL sessions (T77, §12.6, FR-57): a server restart must not log the
// browser out — tokens survive via a hashed-at-rest store file — while expiry
// (auth.session.ttl, default 1d) still bounds a stolen cookie's life. The store
// file never contains a replayable token (§8.7).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_DEFAULT_TTL_MS, SessionStore } from "../src/auth";
import { SESSION_COOKIE, WebchatConnector } from "../src/connector";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-session-"));
  file = join(dir, "sessions", "operator-web.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore: TTL (FR-57)", () => {
  test("the default TTL is 1d (§12.2)", () => {
    expect(SESSION_DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(new SessionStore().ttlMs).toBe(SESSION_DEFAULT_TTL_MS);
  });

  test("a token is live within the TTL and dead past it", () => {
    let now = 1000;
    const store = new SessionStore({ ttlMs: 500, now: () => now });
    const token = store.issue();
    expect(store.has(token)).toBe(true);
    now = 1499;
    expect(store.has(token)).toBe(true);
    now = 1500; // expiresAt is exclusive — the boundary instant is already dead
    expect(store.has(token)).toBe(false);
  });

  test("expiry is permanent — the clock moving back does not resurrect", () => {
    let now = 1000;
    const store = new SessionStore({ ttlMs: 500, now: () => now });
    const token = store.issue();
    now = 2000;
    expect(store.has(token)).toBe(false);
    now = 1200;
    expect(store.has(token)).toBe(false);
  });
});

// --- sliding renewal (T125, FR-86) ---------------------------------------------

describe("SessionStore: sliding renewal (FR-86)", () => {
  test("renew() slides the SAME token's expiry by renewMs; the token survives past the old TTL", () => {
    let now = 1000;
    const store = new SessionStore({ ttlMs: 10_000, renewMs: 30_000, now: () => now });
    const token = store.issue();
    expect(store.expiresAt(token)).toBe(11_000);
    now = 9_000;
    expect(store.renew(token)).toBe(39_000); // now + renewMs
    now = 15_000; // past the ORIGINAL expiry — renewed, still alive
    expect(store.has(token)).toBe(true);
    expect(store.expiresAt(token)).toBe(39_000);
  });

  test("renewMs defaults to the ttl", () => {
    let now = 0;
    const store = new SessionStore({ ttlMs: 10_000, now: () => now });
    const token = store.issue();
    now = 6_000;
    expect(store.renew(token)).toBe(16_000);
  });

  test("an expired/unknown token is NOT resurrected by renew()", () => {
    let now = 0;
    const store = new SessionStore({ ttlMs: 10_000, now: () => now });
    const token = store.issue();
    now = 10_001;
    expect(store.renew(token)).toBeUndefined();
    expect(store.renew("never-issued")).toBeUndefined();
    expect(store.has(token)).toBe(false);
  });

  test("a renewed expiry survives the durable store reload (FR-57)", () => {
    let now = 0;
    const first = new SessionStore({ ttlMs: 10_000, renewMs: 60_000, file, now: () => now });
    const token = first.issue();
    first.renew(token);
    now = 30_000; // far past the original ttl, inside the renewed window
    const second = new SessionStore({ ttlMs: 10_000, renewMs: 60_000, file, now: () => now });
    expect(second.has(token)).toBe(true);
    expect(second.expiresAt(token)).toBe(60_000);
  });
});

describe("SessionStore: durable store (FR-57)", () => {
  test("a token survives a new store instance over the same file", () => {
    const first = new SessionStore({ file });
    const token = first.issue();
    const reborn = new SessionStore({ file });
    expect(reborn.has(token)).toBe(true);
  });

  test("an expired token does not survive the reload", () => {
    let now = 1000;
    const first = new SessionStore({ file, ttlMs: 500, now: () => now });
    const token = first.issue();
    now = 2000;
    const reborn = new SessionStore({ file, ttlMs: 500, now: () => now });
    expect(reborn.has(token)).toBe(false);
  });

  test("a revoked token dies in the durable store too (logout, FR-68)", () => {
    const first = new SessionStore({ file });
    const token = first.issue();
    const other = first.issue();
    first.revoke(token);
    expect(first.has(token)).toBe(false);
    const reborn = new SessionStore({ file }); // no resurrection from disk
    expect(reborn.has(token)).toBe(false);
    expect(reborn.has(other)).toBe(true); // only the revoked one is gone
  });

  test("the file holds SHA-256 hashes, never the token (§8.7)", () => {
    const store = new SessionStore({ file });
    const token = store.issue();
    const contents = readFileSync(file, "utf8");
    expect(contents).not.toContain(token);
    // flat { "<64-hex hash>": expiresAt } object — nothing else
    const parsed = JSON.parse(contents) as Record<string, number>;
    const entries = Object.entries(parsed);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entries[0]?.[1]).toBe("number");
  });

  test("expired entries are swept from the file on the next write", () => {
    let now = 1000;
    const store = new SessionStore({ file, ttlMs: 500, now: () => now });
    store.issue();
    now = 2000;
    const fresh = store.issue(); // sweep happens with this persist
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    expect(Object.keys(parsed)).toHaveLength(1);
    expect(store.has(fresh)).toBe(true);
  });

  test("a corrupt file means an empty store, not a crash", () => {
    writeFileSync(join(dir, "corrupt.json"), "{not json");
    const store = new SessionStore({ file: join(dir, "corrupt.json") });
    expect(store.has("anything")).toBe(false);
    const token = store.issue(); // and it still works from here on
    expect(store.has(token)).toBe(true);
  });

  test("a file with junk shapes keeps only valid entries", () => {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ good: Number.MAX_SAFE_INTEGER, bad: "soon", worse: null }),
    );
    const store = new SessionStore({ file, newToken: () => "t" });
    store.issue();
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["good", createHash("sha256").update("t").digest("hex")].sort(),
    );
  });

  test("writes are tmp+rename — no .tmp residue", () => {
    const store = new SessionStore({ file });
    store.issue();
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(join(dir, "sessions")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("connector: sessions survive a restart (FR-57)", () => {
  async function startedConnector(now?: () => number): Promise<WebchatConnector> {
    const connector = new WebchatConnector({
      bindOperator: "operator-web",
      port: 0,
      password: "hunter2",
      session: { file, ttlMs: 60_000 },
      ...(now !== undefined ? { now } : {}),
    });
    await connector.start(async () => undefined);
    return connector;
  }

  const post = (path: string, body: unknown): Request =>
    new Request(`http://panel.test${path}`, {
      method: "POST",
      headers: { host: "panel.test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function login(connector: WebchatConnector): Promise<string> {
    const response = await connector.handleRequest(post("/api/login", { password: "hunter2" }));
    const token = /muxeon_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    if (token === undefined) throw new Error("no session cookie");
    return `${SESSION_COOKIE}=${token}`;
  }

  test("a pre-restart cookie keeps working after a restart (no re-login)", async () => {
    const first = await startedConnector();
    const cookie = await login(first);
    await first.stop();
    const reborn = await startedConnector();
    try {
      const response = await reborn.handleRequest(
        new Request("http://panel.test/api/peers", { headers: { host: "panel.test", cookie } }),
      );
      expect(response.status).toBe(200);
    } finally {
      await reborn.stop();
    }
  });

  test("an expired cookie is refused after a restart", async () => {
    let now = 1_000_000;
    const first = await startedConnector(() => now);
    const cookie = await login(first);
    await first.stop();
    now += 60_001; // past the 60s ttl
    const reborn = await startedConnector(() => now);
    try {
      const response = await reborn.handleRequest(
        new Request("http://panel.test/api/peers", { headers: { host: "panel.test", cookie } }),
      );
      expect(response.status).toBe(401);
    } finally {
      await reborn.stop();
    }
  });

  test("the cookie's Max-Age mirrors the configured TTL (§12.6)", async () => {
    const connector = await startedConnector();
    try {
      const response = await connector.handleRequest(post("/api/login", { password: "hunter2" }));
      expect(response.headers.get("set-cookie")).toContain("Max-Age=60");
    } finally {
      await connector.stop();
    }
  });
});
