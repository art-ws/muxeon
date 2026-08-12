import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@muxeon/core";
import { type BlobStore, createBlobStore } from "@muxeon/orchestrator";
import { RouteRefusedError } from "../src/contract";
import { type SlackApi, SlackConnector, type SlackIncoming } from "../src/slack";

class FakeSlack implements SlackApi {
  batches: SlackIncoming[][] = [];
  texts: string[] = [];
  filesSent: { name: string; bytes: Uint8Array }[] = [];
  store = new Map<string, Uint8Array>();
  cursors: (string | undefined)[] = [];

  push(...incoming: SlackIncoming[]): void {
    this.batches.push(incoming);
  }

  async poll(cursor: string | undefined) {
    this.cursors.push(cursor);
    const batch = this.batches.shift();
    if (batch !== undefined) {
      const last = batch.at(-1);
      return { incoming: batch, ...(last !== undefined ? { cursor: last.eventId } : {}) };
    }
    return { incoming: [] };
  }

  async sendText(text: string): Promise<void> {
    this.texts.push(text);
  }

  async sendFile(file: { bytes: Uint8Array; name: string }): Promise<void> {
    this.filesSent.push(file);
  }

  async download(fileId: string): Promise<Uint8Array> {
    const bytes = this.store.get(fileId);
    if (bytes === undefined) throw new Error(`no such file ${fileId}`);
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
let api: FakeSlack;
let inbound: Message[];
let connector: SlackConnector;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-slack-"));
  blobs = await createBlobStore(root);
  api = new FakeSlack();
  inbound = [];
});

afterEach(async () => {
  await connector.stop();
  rmSync(root, { recursive: true, force: true });
});

function makeConnector(onInboundError?: (m: Message) => never): SlackConnector {
  connector = new SlackConnector({
    bindOperator: "operator",
    api,
    knownAgents: ["researcher"],
    blobs,
    now: () => 1700000000000,
    pollIdleMs: 5,
  });
  void connector.start(async (m) => {
    if (onInboundError !== undefined) onInboundError(m);
    inbound.push(m);
  });
  return connector;
}

describe("slack connector (T37/S, FR-24b, §3.2/§8.4 — second connector, NFR-7)", () => {
  test("inbound @agent text routes with a deterministic id; the cursor advances", async () => {
    makeConnector();
    api.push({ eventId: "1700000001.000100", text: "@researcher check the thread" });
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual({
      id: "slack-1700000001.000100",
      from: "operator",
      to: "researcher",
      kind: "message",
      ts: 1700000000000,
      payload: "@researcher check the thread",
      origin: "slack",
    });
    await waitFor(() => api.cursors.includes("1700000001.000100"));
  });

  test("no target → clear error in the channel; nothing routed (§3.2)", async () => {
    makeConnector();
    api.push({ eventId: "2", text: "hello" });
    await waitFor(() => api.texts.length === 1);
    expect(api.texts[0]).toContain("no recipient");
    expect(inbound).toHaveLength(0);
  });

  test("a router refusal echoes back (§3.2)", async () => {
    makeConnector((m) => {
      throw new RouteRefusedError("TOPOLOGY_DENIED", m.to);
    });
    api.push({ eventId: "3", text: "@researcher hi" });
    await waitFor(() => api.texts.length === 1);
    expect(api.texts[0]).toContain('cannot deliver to "researcher"');
  });

  test("inbound files land in the blob store; payload carries opaque refs (§5.3)", async () => {
    makeConnector();
    api.store.set("F123", new TextEncoder().encode("spreadsheet"));
    api.push({
      eventId: "4",
      text: "@researcher data attached",
      files: [{ id: "F123", name: "data.csv" }],
    });
    await waitFor(() => inbound.length === 1);
    const payload = inbound[0]?.payload as { blobs: { blob: string; name: string }[] };
    expect(payload.blobs[0]?.name).toBe("data.csv");
    const ref = payload.blobs[0]?.blob ?? "";
    expect(ref).toMatch(/^[A-Za-z0-9-]+(?:\.[a-z0-9]+)?$/); // +ext (T117)
    expect(new TextDecoder().decode(await blobs.read(ref))).toBe("spreadsheet");
  });

  test("deliver pushes attributed text and resolves blobs under blobs/ (§8.4/§8.7)", async () => {
    makeConnector();
    const id = await blobs.write(new TextEncoder().encode("report!"));
    await connector.deliver({
      id: "m1",
      from: "researcher",
      to: "operator",
      kind: "message",
      ts: 0,
      payload: { text: "done", blobs: [{ blob: id, name: "report.txt" }] },
    });
    expect(api.texts).toEqual(["[researcher] done"]);
    expect(api.filesSent[0]?.name).toBe("report.txt");
    expect(new TextDecoder().decode(api.filesSent[0]?.bytes)).toBe("report!");
  });

  test("deliver rejects a traversal blob ref (§8.7/§10.11)", async () => {
    makeConnector();
    await expect(
      connector.deliver({
        id: "m2",
        from: "researcher",
        to: "operator",
        kind: "message",
        ts: 0,
        payload: { blobs: ["../../../etc/hosts"] },
      }),
    ).rejects.toThrow();
    expect(api.filesSent).toHaveLength(0);
  });
});
