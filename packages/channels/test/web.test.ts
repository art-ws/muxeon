// Minimal web connector (T37/S, FR-24b): inbound webhook handled in-process (the
// listener is plain Bun.serve over the same handler), outbound webhook via an
// injected fetch. Text-first; outbound blob refs stay opaque ids (§5.3).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@muxeon/core";
import { RouteRefusedError } from "../src/contract";
import { WebConnector } from "../src/web";

let inbound: Message[];
let connector: WebConnector;
let delivered: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  inbound = [];
  delivered = [];
});

afterEach(async () => {
  await connector.stop();
});

interface MakeOptions {
  readonly secret?: string;
  readonly deliverUrl?: string;
  readonly onInboundError?: (m: Message) => never;
}

async function make(options: MakeOptions = {}): Promise<WebConnector> {
  connector = new WebConnector({
    bindOperator: "operator",
    defaultTarget: "researcher",
    port: 0,
    knownAgents: ["researcher"],
    now: () => 1700000000000,
    newId: () => "web-fixed",
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
    ...(options.deliverUrl !== undefined ? { deliverUrl: options.deliverUrl } : {}),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      delivered.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await connector.start(async (m) => {
    if (options.onInboundError !== undefined) options.onInboundError(m);
    inbound.push(m);
  });
  return connector;
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await connector.handleInbound(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("web connector (T37/S, FR-24b, §3.2)", () => {
  test("inbound {text} routes via @agent/defaultTarget and answers with the queued id", async () => {
    await make();
    const { status, json } = await post({ text: "@researcher look into this" });
    expect(status).toBe(200);
    expect(json).toEqual({ queued: true, id: "web-fixed", to: "researcher" });
    expect(inbound[0]?.payload).toBe("@researcher look into this");
    expect(inbound[0]?.origin).toBe("web");
  });

  test("the caller's id is honored — webhook retries dedup (§10.9)", async () => {
    await make();
    const { json } = await post({ text: "retry me", id: "caller-id-1" });
    expect(json.id).toBe("caller-id-1");
  });

  test("a router refusal returns a clear 422 (§3.2)", async () => {
    await make({
      onInboundError: (m) => {
        throw new RouteRefusedError("TOPOLOGY_DENIED", m.to);
      },
    });
    const { status, json } = await post({ text: "@researcher hi" });
    expect(status).toBe(422);
    expect(String(json.error)).toContain("cannot deliver");
  });

  test("missing text / non-JSON bodies are 400; non-POST is 405", async () => {
    await make();
    expect((await post({})).status).toBe(400);
    const bad = await connector.handleInbound(
      new Request("http://local/", { method: "POST", body: "not json" }),
    );
    expect(bad.status).toBe(400);
    const get = await connector.handleInbound(new Request("http://local/"));
    expect(get.status).toBe(405);
  });

  test("a configured shared secret gates inbound (401 without it)", async () => {
    await make({ secret: "shh-secret" });
    expect((await post({ text: "hi" })).status).toBe(401);
    expect((await post({ text: "hi" }, { "x-muxeon-secret": "shh-secret" })).status).toBe(200);
  });

  test("deliver POSTs the webhook with attribution and opaque blob refs (§5.3)", async () => {
    await make({ deliverUrl: "https://ops.example/hook" });
    await connector.deliver({
      id: "m1",
      from: "researcher",
      to: "operator",
      kind: "message",
      ts: 0,
      payload: { text: "summary ready", blobs: [{ blob: "blob-1", name: "sum.txt" }] },
    });
    expect(delivered[0]?.url).toBe("https://ops.example/hook");
    expect(delivered[0]?.body).toEqual({
      from: "researcher",
      kind: "message",
      text: "summary ready",
      blobs: [{ blob: "blob-1", name: "sum.txt" }],
    });
  });

  test("deliver without a deliverUrl throws — the record stays queued (§10.9)", async () => {
    await make();
    await expect(
      connector.deliver({
        id: "m2",
        from: "researcher",
        to: "operator",
        kind: "message",
        ts: 0,
        payload: "early",
      }),
    ).rejects.toThrow(/no deliverUrl/);
  });
});
