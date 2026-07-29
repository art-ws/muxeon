// Operator-plane HTTP-admin (T31, §8.5, FR-4): agents/lifecycle, channels,
// signals.send. The handlers are exercised in-process via server.adminFetch (a
// local HTTP proxy hijacks loopback fetch — see mcp-helpers); the real network
// surface (path mounting + loopback gate, §8.1) is covered by the LOOPBACK_DIRECT-
// gated tests at the bottom. Lifecycle uses a fake SessionControl; provision/
// restart go through the session's control lane (drained by the dispatcher loop).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@teamai/adapters";
import { TelegramConnector } from "@teamai/channels";
import type { SessionControl } from "@teamai/lifecycle";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";
import { LOOPBACK_DIRECT } from "./mcp-helpers";

function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

class FakeSessions implements SessionControl {
  readonly live = new Set<string>();
  readonly log: string[] = [];

  async hasSession(name: string): Promise<boolean> {
    return this.live.has(name);
  }
  async newSession(name: string): Promise<void> {
    if (this.live.has(name)) throw new Error(`duplicate session: ${name}`);
    this.live.add(name);
    this.log.push(`new:${name}`);
  }
  async killSession(name: string): Promise<void> {
    if (!this.live.has(name)) throw new Error(`no session: ${name}`);
    this.live.delete(name);
    this.log.push(`kill:${name}`);
  }
  async sendLiteral(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> {
    return "";
  }
}

let dir: string;
let sessions: FakeSessions;
let server: TeamaiServer;
let base: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-admin-"));
  sessions = new FakeSessions();
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
      agents: [
        {
          name: "researcher",
          type: "dummy",
          tmux: "researcher-s",
          provision: { command: ["dummy-agent"] },
        },
        { name: "writer", type: "dummy", tmux: "writer-s" }, // attach-only, no provision
      ],
      topology: { researcher: ["operator", "writer"] },
      channels: [{ type: "telegram", token: { $env: "TG" }, bindOperator: "operator" }],
    }),
  );
  mkdirSync(join(dir, "queue"), { recursive: true });
  sessions.live.add("researcher-s");
  sessions.live.add("writer-s");
  server = await bootstrap({
    configFile,
    env: (name) => (name === "TG" ? "tok" : undefined),
    registry: dummyRegistry(),
    probe: (name) => sessions.hasSession(name),
    makeDriver: () => ({ inject: async () => undefined, awaitTurn: async () => undefined }),
    sessionControl: sessions,
    startRoutines: false,
    makeConnector: (config, deps) =>
      new TelegramConnector({
        bindOperator: config.bindOperator,
        api: {
          poll: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return [];
          },
          sendText: async () => undefined,
          sendDocument: async () => undefined,
          download: async () => new Uint8Array(),
        },
        knownAgents: deps.knownAgents,
        blobs: deps.blobs,
      }),
  });
  base = server.adminUrl;
}

async function post(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await server.adminFetch(
    new Request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await server.adminFetch(new Request(`${base}${path}`));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("operator-plane: agents/lifecycle (§8.5, FR-7/8/9)", () => {
  test("GET /admin/agents lists names + status (§5.1)", async () => {
    await boot();
    const { status, json } = await get("/agents");
    expect(status).toBe(200);
    expect(json.agents).toEqual([
      { name: "researcher", session: "researcher-s", status: "idle" },
      { name: "writer", session: "writer-s", status: "idle" },
    ]);
  });

  test("kill → down; restart → idle again (queue keeps draining, §5.1/§10.9)", async () => {
    await boot();
    const killed = await post("/agents/researcher/kill");
    expect(killed.json).toEqual({ status: "down" });
    expect(sessions.live.has("researcher-s")).toBe(false);
    expect(server.status("researcher")).toBe("down");

    const restarted = await post("/agents/researcher/restart");
    expect(restarted.json).toEqual({ status: "idle" });
    expect(sessions.live.has("researcher-s")).toBe(true);
    expect(sessions.log).toEqual(["kill:researcher-s", "new:researcher-s"]);
  });

  test("provision brings a down agent up through the control lane (§8.5)", async () => {
    await boot();
    await post("/agents/researcher/kill");
    const { status, json } = await post("/agents/researcher/provision");
    expect(status).toBe(200);
    expect(json).toEqual({ status: "idle" });
  });

  test("provision of an attach-only agent → clear operator error (§4)", async () => {
    await boot();
    await post("/agents/writer/kill");
    const { status, json } = await post("/agents/writer/provision");
    expect(status).toBe(409);
    expect(json.error).toContain("no provision block");
  });

  test("unknown agent → 404", async () => {
    await boot();
    const { status, json } = await post("/agents/ghost/kill");
    expect(status).toBe(404);
    expect(json.code).toBe("UNKNOWN_AGENT");
  });
});

describe("operator-plane: signals.send (§8.5, FR-19, §8.7)", () => {
  test("send from an agent to a neighbor queues through the router", async () => {
    await boot();
    const { status, json } = await post("/signals/send", {
      from: "researcher",
      to: "writer",
      payload: "sync up",
    });
    expect(status).toBe(200);
    expect(json.queued).toBe(true);
    expect(typeof json.id).toBe("string");
  });

  test('"from" outside the graph is refused — the privilege is bounded by nodes (§8.7)', async () => {
    await boot();
    const { status, json } = await post("/signals/send", {
      from: "ghost",
      to: "researcher",
      payload: "spoof",
    });
    expect(status).toBe(400);
    expect(json.code).toBe("UNKNOWN_FROM");
  });

  test("no topology edge → TOPOLOGY_DENIED (§10.2)", async () => {
    await boot();
    const { status, json } = await post("/signals/send", {
      from: "writer",
      to: "operator", // writer—operator has no edge
      payload: "hi",
    });
    expect(status).toBe(403);
    expect(json.code).toBe("TOPOLOGY_DENIED");
  });

  test("unknown recipient → UNKNOWN_PEER", async () => {
    await boot();
    const { status, json } = await post("/signals/send", {
      from: "researcher",
      to: "nobody",
      payload: "hi",
    });
    expect(status).toBe(404);
    expect(json.code).toBe("UNKNOWN_PEER");
  });

  test('the forward-compat "reaction" kind is accepted; unknown kinds are not (FR-25b)', async () => {
    await boot();
    const reaction = await post("/signals/send", {
      from: "researcher",
      to: "writer",
      kind: "reaction",
      payload: "👍",
    });
    expect(reaction.status).toBe(200);
    const unknown = await post("/signals/send", {
      from: "researcher",
      to: "writer",
      kind: "telepathy",
      payload: "?",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.code).toBe("BAD_KIND");
  });
});

describe("operator-plane: channels + plane separation (§8.5, §10.10)", () => {
  test("GET /admin/channels lists the operator binding and deliver status", async () => {
    await boot();
    const { json } = await get("/channels");
    expect(json.channels).toEqual([
      { operator: "operator", type: "telegram", status: "connected" },
    ]);
  });

  test("an unknown admin operation → 404, never a crash", async () => {
    await boot();
    const { status, json } = await post("/nonsense/op");
    expect(status).toBe(404);
    expect(json.code).toBe("NOT_FOUND");
  });
});

describe.skipIf(!LOOPBACK_DIRECT)(
  "shared surface over the network (§8.1) [needs direct loopback]",
  () => {
    test("mcp:false → /mcp is not served while /admin answers on the same port", async () => {
      await boot();
      const mcp = await fetch(base.replace("/admin", "/mcp"), { method: "POST", body: "{}" });
      expect(mcp.status).toBe(404);
      const admin = await fetch(`${base}/agents`);
      expect(admin.status).toBe(200);
    });
  },
);
