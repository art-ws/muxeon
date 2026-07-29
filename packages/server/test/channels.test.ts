// T30 integration (Checkpoint 8, §3.2/FR-37): inbound from telegram → router →
// agent dispatcher injects it; the agent's reply routed to the operator → egress
// dispatcher → connector deliver → pushed to the (fake) telegram chat. Built on
// bootstrap with a fake session driver and a fake Telegram Bot API — the real
// TelegramConnector and egress wiring in between.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@teamai/adapters";
import { type TelegramApi, TelegramConnector, type TelegramIncoming } from "@teamai/channels";
import { bootstrap } from "../src/bootstrap";

class FakeApi implements TelegramApi {
  batches: TelegramIncoming[][] = [];
  texts: { chatId: number | string; text: string }[] = [];
  documents: { chatId: number | string; name: string }[] = [];

  push(...incoming: TelegramIncoming[]): void {
    this.batches.push(incoming);
  }

  async poll(): Promise<readonly TelegramIncoming[]> {
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
    this.documents.push({ chatId, name: document.name });
  }

  async download(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

let dir: string;
let api: FakeApi;
let injected: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-channels-"));
  api = new FakeApi();
  injected = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(): string {
  const configFile = join(dir, "teamai.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 8080, mcp: false, queueDir: "./queue" },
      agents: [
        { name: "researcher", type: "dummy", tmux: "researcher-s" },
        { name: "loner", type: "dummy", tmux: "loner-s" }, // no edge to the operator
      ],
      topology: { researcher: ["operator"] },
      channels: [
        {
          type: "telegram",
          token: { $env: "TELEGRAM_TOKEN" },
          bindOperator: "operator",
          defaultTarget: "researcher",
        },
      ],
    }),
  );
  return configFile;
}

async function boot() {
  return bootstrap({
    configFile: writeConfig(),
    env: (name) => (name === "TELEGRAM_TOKEN" ? "test-token" : undefined),
    registry: dummyRegistry(),
    probe: async () => true, // every tmux session "exists"
    makeDriver: () => ({
      inject: async (text: string) => {
        injected.push(text);
      },
      awaitTurn: async () => undefined, // instant turn
    }),
    startRoutines: false,
    makeConnector: (config, deps) =>
      new TelegramConnector({
        bindOperator: config.bindOperator,
        ...(config.defaultTarget !== undefined ? { defaultTarget: config.defaultTarget } : {}),
        api,
        knownAgents: deps.knownAgents,
        blobs: deps.blobs,
      }),
  });
}

describe("channel wiring (T30, Checkpoint 8: §3.2, §10.8/§10.9, FR-37)", () => {
  test("operator @agent text → routed → injected into the agent's session", async () => {
    const server = await boot();
    try {
      expect([...server.channels.keys()]).toEqual(["operator"]);
      api.push({ updateId: 1, chatId: 7, text: "@researcher find bun docs" });
      // ≥1: the reply-less dummy agent also earns a FR-45 nudge injection.
      await waitFor(() => injected.length >= 1);
      expect(injected[0]).toContain("find bun docs");
      // and the turn completed to done/ in the agent's queue
      const done = join(dir, "queue", "researcher-s", "done");
      await waitFor(() => readdirSync(done).some((f) => f.endsWith(".json")));
      // FR-45: the dummy agent never called send → exactly one nudge follows,
      // and the nudge itself never nudges (stable at 2 injections).
      await waitFor(() => injected.length === 2);
      expect(injected[1]).toContain('send(to="operator"');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(injected).toHaveLength(2); // no nudge loop
    } finally {
      await server.stop();
    }
  });

  test("agent reply → operator pseudo-session → egress → pushed to the chat", async () => {
    const server = await boot();
    try {
      api.push({ updateId: 2, chatId: 9, text: "@researcher hi" }); // chat becomes known
      await waitFor(() => injected.length >= 1);
      const result = await server.router.route({
        id: "reply-1",
        from: "researcher",
        to: "operator",
        kind: "message",
        ts: Date.now(),
        payload: "found three docs",
      });
      expect(result.ok).toBe(true);
      await waitFor(() => api.texts.some((t) => t.text.includes("found three docs")));
      expect(api.texts.at(-1)).toEqual({ chatId: 9, text: "[researcher] found three docs" });
      // completed to done/ in the operator's pseudo-session (§5.3)
      const done = join(dir, "queue", "operator", "done");
      expect(readdirSync(done).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test("a reply queued before any chat is known is delivered once the operator writes (§10.9)", async () => {
    const server = await boot();
    try {
      // no inbound yet → deliver throws (no chat) → the record waits in the queue
      const result = await server.router.route({
        id: "early-1",
        from: "researcher",
        to: "operator",
        kind: "message",
        ts: Date.now(),
        payload: "early news",
      });
      expect(result.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(api.texts).toHaveLength(0); // not deliverable yet, but not lost
      api.push({ updateId: 3, chatId: 11, text: "@researcher hello" }); // chat learned
      await waitFor(() => api.texts.some((t) => t.text.includes("early news")));
      expect(api.texts.find((t) => t.text.includes("early news"))?.chatId).toBe(11);
    } finally {
      await server.stop();
    }
  });

  test("@agent without a topology edge → TOPOLOGY_DENIED echoed to the operator (§3.2/§10.2)", async () => {
    const server = await boot();
    try {
      api.push({ updateId: 4, chatId: 5, text: "@loner do something" });
      await waitFor(() => api.texts.length === 1);
      expect(api.texts[0]?.text).toContain('cannot deliver to "loner"');
      expect(injected).toHaveLength(0); // nothing reached any agent
    } finally {
      await server.stop();
    }
  });

  test("an unknown channel type fails the boot (fail-fast)", async () => {
    const configFile = join(dir, "teamai.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        server: { port: 8080, mcp: false, queueDir: "./queue" },
        agents: [{ name: "researcher", type: "dummy", tmux: "researcher-s" }],
        topology: { researcher: ["operator"] },
        channels: [{ type: "carrier-pigeon", bindOperator: "operator" }],
      }),
    );
    await expect(
      bootstrap({
        configFile,
        registry: dummyRegistry(),
        probe: async () => true,
        startRoutines: false,
      }),
    ).rejects.toThrow(/unknown channel type "carrier-pigeon"/);
  });
});
