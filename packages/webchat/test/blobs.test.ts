// T47 (FR-41, §12.5): media through the panel — multipart upload behind the caps
// (size, mime allowlist) into the blob store, opaque refs in /api/send payloads,
// download under containment (§8.7) with upload-time mime (never per-request) and
// attachment disposition for non-media (§12.6).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@muxeon/core";
import { SESSION_COOKIE, type WebchatBlobStore, WebchatConnector } from "../src/connector";
import { HistoryStore } from "../src/history";

let dir: string;
let history: HistoryStore;
let inbound: Message[];

/** In-memory store with the same containment stance: a non-issued id throws. */
class FakeBlobStore implements WebchatBlobStore {
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
    if (found === undefined) throw new Error("containment refused"); // like §8.7
    return found;
  }
}

let blobs: FakeBlobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-blobs-"));
  history = new HistoryStore({ dir: join(dir, "operator-web"), operator: "operator-web" });
  inbound = [];
  blobs = new FakeBlobStore();
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
    blobs,
    ...overrides,
  });
  await connector.start(async (message) => {
    inbound.push(message);
  });
  return connector;
}

async function login(connector: WebchatConnector): Promise<string> {
  const response = await connector.handleRequest(
    new Request("http://panel.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", host: "panel.test" },
      body: JSON.stringify({ password: "hunter2" }),
    }),
  );
  const token = /muxeon_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (token === undefined) throw new Error("no session cookie issued");
  return `${SESSION_COOKIE}=${token}`;
}

function uploadRequest(
  cookie: string,
  options: { name?: string; mime?: string; bytes?: Uint8Array } = {},
): Request {
  const form = new FormData();
  const bytes = options.bytes ?? new TextEncoder().encode("media-bytes");
  form.set(
    "file",
    new File([bytes.slice().buffer as ArrayBuffer], options.name ?? "photo.jpg", {
      type: options.mime ?? "image/jpeg",
    }),
  );
  return new Request("http://panel.test/api/blobs", {
    method: "POST",
    headers: { host: "panel.test", cookie },
    body: form,
  });
}

function sendRequest(cookie: string, body: unknown): Request {
  return new Request("http://panel.test/api/send", {
    method: "POST",
    headers: { "content-type": "application/json", host: "panel.test", cookie },
    body: JSON.stringify(body),
  });
}

const getBlob = (cookie: string, id: string): Request =>
  new Request(`http://panel.test/api/blobs/${id}`, { method: "GET", headers: { cookie } });

describe("upload (§12.5)", () => {
  test("multipart file → opaque id + metadata; bytes land in the store", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      const response = await connector.handleRequest(uploadRequest(cookie));
      expect(response.status).toBe(200);
      const meta = (await response.json()) as Record<string, unknown>;
      expect(meta).toEqual({ id: "blob-1", name: "photo.jpg", mime: "image/jpeg", size: 11 });
      expect(blobs.bytes.get("blob-1")).toEqual(new TextEncoder().encode("media-bytes"));
    } finally {
      await connector.stop();
    }
  });

  test("oversize → 413, nothing stored", async () => {
    const connector = await startedConnector({ upload: { maxBytes: 4 } });
    try {
      const cookie = await login(connector);
      const response = await connector.handleRequest(uploadRequest(cookie));
      expect(response.status).toBe(413);
      expect(blobs.bytes.size).toBe(0);
    } finally {
      await connector.stop();
    }
  });

  test("a mime outside the allowlist → 415; wildcard and exact patterns both match", async () => {
    const connector = await startedConnector({ upload: { mime: ["image/*", "application/pdf"] } });
    try {
      const cookie = await login(connector);
      const evil = await connector.handleRequest(
        uploadRequest(cookie, { mime: "application/x-sh", name: "run.sh" }),
      );
      expect(evil.status).toBe(415);
      expect(blobs.bytes.size).toBe(0);
      expect((await connector.handleRequest(uploadRequest(cookie))).status).toBe(200);
      expect(
        (
          await connector.handleRequest(
            uploadRequest(cookie, { mime: "application/pdf", name: "doc.pdf" }),
          )
        ).status,
      ).toBe(200);
    } finally {
      await connector.stop();
    }
  });

  test("unauthenticated upload/download stay behind the gate (§10.12)", async () => {
    const connector = await startedConnector();
    try {
      const upload = await connector.handleRequest(uploadRequest(""));
      expect(upload.status).toBe(401);
      const download = await connector.handleRequest(getBlob("", "blob-1"));
      expect(download.status).toBe(401);
      expect(blobs.bytes.size).toBe(0);
    } finally {
      await connector.stop();
    }
  });
});

describe("send with blobs (§12.5, §5.3 payload convention)", () => {
  test("uploaded ids ride the payload as refs with upload-time metadata", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      await connector.handleRequest(uploadRequest(cookie));
      const response = await connector.handleRequest(
        sendRequest(cookie, { to: "researcher", text: "see photo", blobs: ["blob-1"], id: "m-1" }),
      );
      expect(response.status).toBe(200);
      expect(inbound[0]?.payload).toEqual({
        text: "see photo",
        blobs: [{ blob: "blob-1", name: "photo.jpg", mime: "image/jpeg", size: 11 }],
      });
    } finally {
      await connector.stop();
    }
  });

  test("blobs-only send is valid; text-only payload stays a plain string", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      await connector.handleRequest(uploadRequest(cookie));
      const blobOnly = await connector.handleRequest(
        sendRequest(cookie, { to: "researcher", blobs: ["blob-1"], id: "m-1" }),
      );
      expect(blobOnly.status).toBe(200);
      expect(inbound[0]?.payload).toEqual({
        blobs: [{ blob: "blob-1", name: "photo.jpg", mime: "image/jpeg", size: 11 }],
      });
      const textOnly = await connector.handleRequest(
        sendRequest(cookie, { to: "researcher", text: "plain", id: "m-2" }),
      );
      expect(textOnly.status).toBe(200);
      expect(inbound[1]?.payload).toBe("plain");
    } finally {
      await connector.stop();
    }
  });

  test("an unknown blob id → 422, nothing routed; empty send → 400", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      const unknown = await connector.handleRequest(
        sendRequest(cookie, { to: "researcher", blobs: ["ghost"], id: "m-1" }),
      );
      expect(unknown.status).toBe(422);
      const empty = await connector.handleRequest(
        sendRequest(cookie, { to: "researcher", id: "m-2" }),
      );
      expect(empty.status).toBe(400);
      expect(inbound).toHaveLength(0);
    } finally {
      await connector.stop();
    }
  });
});

describe("download (§12.5/§12.6, §8.7)", () => {
  test("bytes round-trip; image is inline, pdf downloads as attachment", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      await connector.handleRequest(uploadRequest(cookie)); // blob-1 image/jpeg
      await connector.handleRequest(
        uploadRequest(cookie, { mime: "application/pdf", name: "doc.pdf" }), // blob-2
      );
      const image = await connector.handleRequest(getBlob(cookie, "blob-1"));
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/jpeg");
      expect(image.headers.get("content-disposition")).toBeNull();
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(
        new TextEncoder().encode("media-bytes"),
      );
      const pdf = await connector.handleRequest(getBlob(cookie, "blob-2"));
      expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="doc.pdf"');
    } finally {
      await connector.stop();
    }
  });

  test("a traversal-looking id is a plain 404 — no path details leak (§8.7/§10.11)", async () => {
    const connector = await startedConnector();
    try {
      const cookie = await login(connector);
      const response = await connector.handleRequest(getBlob(cookie, "..%2F..%2Fetc%2Fpasswd"));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("/etc");
    } finally {
      await connector.stop();
    }
  });

  test("after a restart the mime comes from the history record (§12.5)", async () => {
    const first = await startedConnector();
    const cookie = await login(first);
    await first.handleRequest(uploadRequest(cookie));
    await first.handleRequest(
      sendRequest(cookie, { to: "researcher", blobs: ["blob-1"], id: "m-1" }),
    );
    await first.stop();

    // a fresh connector: empty upload cache, same history + blob store
    const reborn = await startedConnector({
      history: new HistoryStore({ dir: join(dir, "operator-web"), operator: "operator-web" }),
    });
    try {
      const cookie2 = await login(reborn);
      const response = await reborn.handleRequest(getBlob(cookie2, "blob-1"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
    } finally {
      await reborn.stop();
    }
  });
});
