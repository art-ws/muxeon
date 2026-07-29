// T35 (§8.7, FR-36, NFR-6/NFR-9): resolved $env secrets never reach queue
// records, admin responses, or operator-facing errors; unexpected admin failures
// collapse to a generic message (no internal paths). The maildir + admin peek/
// status remain the observability surface (asserted en route).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@teamai/adapters";
import { TelegramConnector, type TelegramIncoming } from "@teamai/channels";
import { AdminError } from "../src/admin/error";
import { createAdminHandler } from "../src/admin/plane";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";
import { createTextRedactor } from "../src/redact";

const TOKEN = "S3CRET-TELEGRAM-T0KEN-VALUE";

function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

describe("createTextRedactor (§8.7)", () => {
  test("scrubs every occurrence of every secret", () => {
    const redact = createTextRedactor([TOKEN, "OTHER-SECRET"]);
    expect(redact(`a ${TOKEN} b OTHER-SECRET c ${TOKEN}`)).toBe(
      "a [redacted] b [redacted] c [redacted]",
    );
  });

  test("ignores trivially short values (would shred unrelated text)", () => {
    expect(createTextRedactor(["ab"])("about abab")).toBe("about abab");
  });
});

describe("no-leak sweep across a full operator↔agent exchange", () => {
  let dir: string;
  let server: TeamaiServer;
  let inbox: TelegramIncoming[][];
  let sentTexts: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamai-redaction-"));
    inbox = [];
    sentTexts = [];
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<void> {
    const configFile = join(dir, "teamai.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        server: { port: 0, mcp: false, queueDir: "./queue" },
        agents: [{ name: "researcher", type: "dummy", tmux: "researcher-s" }],
        topology: { researcher: ["operator"] },
        channels: [{ type: "telegram", token: { $env: "TG" }, bindOperator: "operator" }],
      }),
    );
    server = await bootstrap({
      configFile,
      env: (name) => (name === "TG" ? TOKEN : undefined),
      registry: dummyRegistry(),
      probe: async () => true,
      makeDriver: () => ({ inject: async () => undefined, awaitTurn: async () => undefined }),
      startRoutines: false,
      makeConnector: (config, deps) =>
        new TelegramConnector({
          bindOperator: config.bindOperator,
          api: {
            poll: async () => {
              const batch = inbox.shift();
              if (batch !== undefined) return batch;
              await new Promise((resolve) => setTimeout(resolve, 5));
              return [];
            },
            sendText: async (_chat, text) => {
              sentTexts.push(text);
            },
            sendDocument: async () => undefined,
            download: async () => new Uint8Array(),
          },
          knownAgents: deps.knownAgents,
          blobs: deps.blobs,
        }),
    });
  }

  async function admin(method: string, path: string, body?: unknown): Promise<string> {
    const response = await server.adminFetch(
      new Request(`${server.adminUrl}${path}`, {
        method,
        ...(body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      }),
    );
    return response.text();
  }

  test("the resolved channel secret appears nowhere downstream", async () => {
    await boot();

    // a full §3.2 round-trip: operator → agent, agent reply → operator
    inbox.push([{ updateId: 1, chatId: 7, text: "@researcher status?" }]);
    await new Promise((resolve) => setTimeout(resolve, 250)); // inbound processed + turn done
    const reply = await server.router.route({
      id: "r1",
      from: "researcher",
      to: "operator",
      kind: "message",
      ts: Date.now(),
      payload: "all green",
    });
    expect(reply.ok).toBe(true);
    const deadline = Date.now() + 5000;
    while (!sentTexts.some((t) => t.includes("all green"))) {
      if (Date.now() > deadline) throw new Error("reply never delivered");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // 1. queue records (every session, every sub-state) carry no config data (§5.3/§8.7)
    const queueFiles = walkFiles(join(dir, "queue"));
    expect(queueFiles.length).toBeGreaterThan(0); // the maildir IS observable (NFR-9)
    for (const file of queueFiles) {
      expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
    }

    // 2. admin surfaces: status (NFR-9) is readable and secret-free
    const agents = await admin("GET", "/agents");
    expect(agents).toContain('"status":"idle"');
    expect(agents).not.toContain(TOKEN);
    expect(await admin("GET", "/channels")).not.toContain(TOKEN);
    expect(await admin("GET", "/queues/operator")).not.toContain(TOKEN);

    // 3. outbound channel pushes carry no secret either
    for (const text of sentTexts) expect(text).not.toContain(TOKEN);
  });
});

describe("admin error boundary (§8.7)", () => {
  const stub = <T>(value: T): T => value;

  function handlerWith(error: unknown): (req: Request) => Promise<Response> {
    return createAdminHandler({
      redactText: createTextRedactor([TOKEN]),
      lifecycle: stub({
        list: () => {
          throw error;
        },
        provision: async () => "idle" as const,
        kill: async () => "down" as const,
        restart: async () => "idle" as const,
        shutdown: async () => "down" as const,
        reload: async () => "idle" as const,
        commands: () => [],
        command: async () => "",
      }),
      commandFanout: async (slash: string, selectors: readonly string[]) => ({
        ok: true as const,
        kind: "command-fanout" as const,
        slash,
        selectors,
        targets: [],
        fanout: [],
      }),
      channels: stub({ list: () => [] }),
      signals: stub({
        send: async () => ({ id: "x", queued: true as const }),
      }),
      blobs: stub({
        upload: async () => ({ id: "b", size: 0 }),
      }),
      queues: stub({
        peek: async () => ({ pending: [], cur: [] }),
        cancel: async () => ({ cancelled: true as const }),
        requeue: async () => ({ outcome: "already-done" as const }),
      }),
      routines: stub({
        list: async () => [],
        get: async () => {
          throw new AdminError(404, "x");
        },
        put: async () => ({ owner: "o", id: "i" }),
        delete: async () => ({ deleted: true as const }),
        setEnabled: async () => ({ enabled: true }),
        runOnce: async () => ({ id: "x", queued: true as const, target: "t" }),
      }),
    });
  }

  test("an AdminError that embeds a secret is scrubbed at the boundary", async () => {
    const handler = handlerWith(new AdminError(409, `upstream said: ${TOKEN}`));
    const response = await handler(new Request("http://local/admin/agents"));
    const text = await response.text();
    expect(response.status).toBe(409);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(TOKEN);
  });

  test("an unexpected error collapses to a generic message — no internal paths", async () => {
    const handler = handlerWith(new Error(`ENOENT ${join("/var", "secret", "queue", "cur")}`));
    const response = await handler(new Request("http://local/admin/agents"));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toBe('{"error":"internal error"}');
  });
});
