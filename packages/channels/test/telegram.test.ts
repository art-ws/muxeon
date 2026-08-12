import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@muxeon/core";
import { type BlobStore, createBlobStore } from "@muxeon/orchestrator";
import { RouteRefusedError } from "../src/contract";
import { type TelegramApi, TelegramConnector, type TelegramIncoming } from "../src/telegram";

class FakeApi implements TelegramApi {
  batches: TelegramIncoming[][] = [];
  texts: { chatId: number | string; text: string }[] = [];
  documents: { chatId: number | string; name: string; bytes: Uint8Array }[] = [];
  files = new Map<string, Uint8Array>();
  offsets: number[] = [];

  push(...incoming: TelegramIncoming[]): void {
    this.batches.push(incoming);
  }

  async poll(offset: number): Promise<readonly TelegramIncoming[]> {
    this.offsets.push(offset);
    const batch = this.batches.shift();
    if (batch !== undefined) return batch;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [];
  }

  async sendText(chatId: number | string, text: string): Promise<void> {
    this.texts.push({ chatId, text });
  }

  async sendDocument(
    chatId: number | string,
    document: { bytes: Uint8Array; name: string },
  ): Promise<void> {
    this.documents.push({ chatId, name: document.name, bytes: document.bytes });
  }

  async download(fileId: string): Promise<Uint8Array> {
    const bytes = this.files.get(fileId);
    if (bytes === undefined) throw new Error(`no such file: ${fileId}`);
    return bytes;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let root: string;
let blobs: BlobStore;
let api: FakeApi;
let inbound: Message[];
let connector: TelegramConnector;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-telegram-"));
  blobs = await createBlobStore(root);
  api = new FakeApi();
  inbound = [];
});

afterEach(async () => {
  await connector.stop();
  rmSync(root, { recursive: true, force: true });
});

function makeConnector(
  onInboundError?: (m: Message) => never,
  defaultTarget?: string,
): TelegramConnector {
  connector = new TelegramConnector({
    bindOperator: "operator",
    ...(defaultTarget !== undefined ? { defaultTarget } : {}),
    api,
    knownAgents: ["researcher", "writer"],
    blobs,
    now: () => 1700000000000,
  });
  void connector.start(async (m) => {
    if (onInboundError !== undefined) onInboundError(m);
    inbound.push(m);
  });
  return connector;
}

describe("telegram connector (§3.2, §8.4, FR-24a/FR-25a/FR-26)", () => {
  test("inbound @agent text becomes a routed Message with a deterministic id", async () => {
    makeConnector();
    api.push({ updateId: 41, chatId: 7, text: "@researcher dig into bun workspaces" });
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual({
      id: "telegram-41", // deterministic per update → re-poll dedups (§10.9)
      from: "operator",
      to: "researcher",
      kind: "message",
      ts: 1700000000000,
      payload: "@researcher dig into bun workspaces",
      origin: "telegram",
    });
    await waitFor(() => api.offsets.includes(42)); // offset advanced past the update
  });

  test("no @agent and no defaultTarget → clear error to the operator, nothing routed (§3.2)", async () => {
    makeConnector();
    api.push({ updateId: 1, chatId: 7, text: "hello there" });
    await waitFor(() => api.texts.length === 1);
    expect(api.texts[0]?.chatId).toBe(7);
    expect(api.texts[0]?.text).toContain("no recipient");
    expect(inbound).toHaveLength(0);
  });

  test("no @agent with a defaultTarget routes to it (§3.2)", async () => {
    makeConnector(undefined, "writer");
    api.push({ updateId: 2, chatId: 7, text: "draft the intro" });
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]?.to).toBe("writer");
  });

  test("a router refusal is reported back to the operator in the same chat (§3.2)", async () => {
    makeConnector((m) => {
      throw new RouteRefusedError("TOPOLOGY_DENIED", m.to);
    });
    api.push({ updateId: 3, chatId: 9, text: "@writer hi" });
    await waitFor(() => api.texts.length === 1);
    expect(api.texts[0]?.chatId).toBe(9);
    expect(api.texts[0]?.text).toContain('cannot deliver to "writer"');
  });

  test("an unexpected onInbound error yields a generic operator notice (§8.7 redaction)", async () => {
    makeConnector(() => {
      throw new Error("ENOENT /secret/internal/path");
    });
    api.push({ updateId: 4, chatId: 9, text: "@writer hi" });
    await waitFor(() => api.texts.length === 1);
    expect(api.texts[0]?.text).toBe("muxeon: delivery failed");
    expect(api.texts[0]?.text).not.toContain("/secret"); // no internal paths leak
  });

  test("inbound media is stored as a blob; the payload carries an opaque ref (§5.3)", async () => {
    makeConnector();
    api.files.set("file-1", new TextEncoder().encode("report bytes"));
    api.push({
      updateId: 5,
      chatId: 7,
      text: "@researcher see the report",
      media: [{ fileId: "file-1", name: "report.pdf" }],
    });
    await waitFor(() => inbound.length === 1);
    const payload = inbound[0]?.payload as {
      text: string;
      blobs: { blob: string; name: string }[];
    };
    expect(payload.text).toBe("@researcher see the report");
    expect(payload.blobs).toHaveLength(1);
    const ref = payload.blobs[0];
    if (ref === undefined) throw new Error("expected a blob ref");
    expect(ref.name).toBe("report.pdf");
    expect(ref.blob).toMatch(/^[A-Za-z0-9-]+(?:\.[a-z0-9]+)?$/); // opaque id (+ext, T117), never a path (§5.3)
    expect(new TextDecoder().decode(await blobs.read(ref.blob))).toBe("report bytes");
  });

  test("a failed media download yields an operator notice, nothing routed", async () => {
    makeConnector();
    api.push({
      updateId: 6,
      chatId: 7,
      text: "@researcher attached",
      media: [{ fileId: "missing" }],
    });
    await waitFor(() => api.texts.length === 1);
    expect(api.texts[0]?.text).toContain("media");
    expect(inbound).toHaveLength(0);
  });

  test("deliver pushes text to the last seen chat with sender attribution", async () => {
    makeConnector();
    api.push({ updateId: 7, chatId: 12, text: "@researcher hi" });
    await waitFor(() => inbound.length === 1);
    await connector.deliver({
      id: "m1",
      from: "researcher",
      to: "operator",
      kind: "message",
      ts: 0,
      payload: "found three candidates",
    });
    expect(api.texts).toEqual([{ chatId: 12, text: "[researcher] found three candidates" }]);
  });

  test("deliver resolves blob refs to bytes and pushes documents (§8.4)", async () => {
    makeConnector();
    api.push({ updateId: 8, chatId: 12, text: "@researcher hi" });
    await waitFor(() => inbound.length === 1);
    const id = await blobs.write(new TextEncoder().encode("csv,data"));
    await connector.deliver({
      id: "m2",
      from: "researcher",
      to: "operator",
      kind: "message",
      ts: 0,
      payload: { text: "results attached", blobs: [{ blob: id, name: "results.csv" }] },
    });
    expect(api.texts[0]?.text).toBe("[researcher] results attached");
    expect(api.documents).toHaveLength(1);
    expect(api.documents[0]?.name).toBe("results.csv");
    expect(new TextDecoder().decode(api.documents[0]?.bytes)).toBe("csv,data");
  });

  test("deliver rejects a traversal blob ref — containment under blobs/ (§8.7, §10.11)", async () => {
    makeConnector();
    api.push({ updateId: 9, chatId: 12, text: "@researcher hi" });
    await waitFor(() => inbound.length === 1);
    const traversal = connector.deliver({
      id: "m3",
      from: "researcher",
      to: "operator",
      kind: "message",
      ts: 0,
      payload: { blobs: ["../../etc/passwd"] },
    });
    await expect(traversal).rejects.toThrow();
    expect(api.documents).toHaveLength(0); // nothing exfiltrated
  });

  test("deliver before any inbound chat throws — the record stays queued (§10.9)", async () => {
    makeConnector();
    const attempt = connector.deliver({
      id: "m4",
      from: "researcher",
      to: "operator",
      kind: "message",
      ts: 0,
      payload: "early",
    });
    await expect(attempt).rejects.toThrow(/no telegram chat known yet/);
  });
});
