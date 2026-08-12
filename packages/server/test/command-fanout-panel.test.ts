// Panel command-fanout end-to-end (§15.8, FR-115): the REAL bootstrap wiring —
// POST /api/agents/command over the webchat channel resolves the selector
// intersection against the full config, but dispatches ONLY to the bound
// operator's topology NEIGHBOURS (§10.2); a stranger in the intersection comes
// back COMMAND_DENIED. Self-contained on ephemeral ports (server.port 0) so it
// never collides with a live stand on :8080.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@muxeon/adapters";
import type { SessionControl } from "@muxeon/lifecycle";
import { type MuxeonServer, bootstrap } from "../src/bootstrap";

const PANEL_PORT = 19000 + Math.floor(Math.random() * 1500);
let dir: string;

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
  async hasSession(): Promise<boolean> {
    return true;
  }
  async newSession(): Promise<void> {}
  async killSession(): Promise<void> {}
  async sendLiteral(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> {
    return "";
  }
}

async function boot(): Promise<MuxeonServer> {
  const configFile = join(dir, "muxeon.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: false, queueDir: "./queue" },
      agents: [
        // researcher ↔ operator-web (neighbour); loner is in the group but has NO
        // edge to the operator. Distinct tags let a tag narrow the group.
        {
          name: "researcher",
          type: "dummy",
          tmux: "researcher-s",
          group: "team",
          tags: ["backend"],
          commands: [{ slash: "ping" }],
        },
        {
          name: "loner",
          type: "dummy",
          tmux: "loner-s",
          group: "team",
          tags: ["frontend"],
          commands: [{ slash: "ping" }],
        },
      ],
      groups: [{ name: "team" }],
      topology: { researcher: ["operator-web", "loner"] },
      channels: [
        {
          type: "webchat",
          bindOperator: "operator-web",
          port: PANEL_PORT,
          auth: { password: { $env: "MUXEON_WEB_PASSWORD" } },
        },
      ],
    }),
  );
  return bootstrap({
    configFile,
    env: (name) => (name === "MUXEON_WEB_PASSWORD" ? "hunter2" : undefined),
    registry: dummyRegistry(),
    probe: async () => true,
    sessionControl: new FakeSessions(),
    makeDriver: () => ({ inject: async () => undefined, awaitTurn: async () => undefined }),
    startRoutines: false,
  });
}

const api = (path: string): string => `http://127.0.0.1:${PANEL_PORT}${path}`;

async function loginCookie(): Promise<string> {
  const res = await fetch(api("/api/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function command(cookie: string, slash: string, selectors: string[]): Promise<Response> {
  return fetch(api("/api/agents/command"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ slash, selectors }),
  });
}

describe("panel /api/agents/command (§15.8, FR-115)", () => {
  let server: MuxeonServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "muxeon-cmdfan-panel-"));
    server = await boot();
  });
  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a group hits neighbours, DENIES strangers (§10.2 per-agent gate)", async () => {
    const cookie = await loginCookie();
    const res = await command(cookie, "ping", ["team"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: string[];
      fanout: { to: string; ok: boolean; code?: string }[];
    };
    expect(new Set(body.targets)).toEqual(new Set(["researcher", "loner"])); // full group resolved
    const byName = Object.fromEntries(body.fanout.map((e) => [e.to, e]));
    expect(byName.researcher?.ok).toBe(true); // neighbour → dispatched (idle, capture "")
    expect(byName.loner?.ok).toBe(false);
    expect(byName.loner?.code).toBe("COMMAND_DENIED"); // stranger → gated, never reached
  });

  test("group ∩ tag narrows before the neighbour gate", async () => {
    const cookie = await loginCookie();
    const res = await command(cookie, "ping", ["team", "backend"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: string[];
      fanout: { to: string; ok: boolean; output?: string }[];
    };
    expect(body.targets).toEqual(["researcher"]); // team ∩ backend = {researcher}
    expect(body.fanout).toEqual([{ to: "researcher", ok: true, output: "" }]);
  });

  test("an unknown selector → 400; unauthenticated → 401", async () => {
    const cookie = await loginCookie();
    const unknown = await command(cookie, "ping", ["team", "ghost"]);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { code: string }).code).toBe("UNKNOWN_SELECTOR");

    const anon = await command("", "ping", ["team"]);
    expect(anon.status).toBe(401);
  });
});
