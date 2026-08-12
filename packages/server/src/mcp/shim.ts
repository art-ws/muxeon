// Agent-side MCP shim (§8.6, FR-44/FR-89): a DURABLE stdio↔Streamable-HTTP proxy that
// lets a CLI agent join the agent-plane under its TOPOLOGY name. Native MCP clients of
// CLI agents (claude/openclaude) declare their own clientInfo.name (`claude-code`) and
// cannot be told to declare the agent's identity — so the agent's OWNER registers this
// shim as a stdio MCP server (e.g. in the workspace .mcp.json) and the shim performs the
// upstream `initialize` with clientInfo.name = MUXEON_AGENT_NAME. Registration is the
// owner's action in the agent's own config — MUXEON itself never touches agent
// configuration (FR-11b).
//
// DURABILITY (FR-89). The agent's stdio link to the shim is the stable contract; the
// upstream HTTP session is disposable. The shim NEVER holds a single long-lived session
// hostage: it connects to the agent-plane LAZILY and, on ANY upstream failure — a server
// restart invalidates our session id (→ 404 "unknown session"); a server still booting
// refuses the connection — it drops the dead client and RE-INITIALIZES on the next call.
// So a MUXEON server restart no longer severs agents: no `muxeon restart <agent>` needed.
// A shim that started BEFORE the server keeps retrying in the background and, on the first
// connect, emits tools/list_changed so the agent's client lists the §8.6 tools once they
// appear. The proxy stays transparent: tools/list and tools/call are forwarded verbatim,
// so the agent sees exactly the §8.6 set and nothing here changes when the plane evolves.
//
// Run: MUXEON_AGENT_NAME=<topology-name> bun packages/server/src/mcp/shim.ts
// Env: MUXEON_MCP_URL — agent-plane endpoint (default http://127.0.0.1:8080/mcp).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// The agent-plane is loopback — a dev HTTP proxy (HTTP_PROXY etc.) must not
// hijack it. Bun snapshots proxy env at PROCESS START, so a runtime `delete`
// is too late (verified live: Privoxy still intercepted) — re-exec ourselves
// once with the proxy variables stripped, inheriting stdio so the MCP stdin/
// stdout pipe passes straight through to the replacement.
const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"];
if (
  import.meta.main &&
  PROXY_VARS.some((key) => process.env[key] !== undefined) &&
  process.env.MUXEON_SHIM_REEXEC !== "1"
) {
  const env: Record<string, string | undefined> = { ...process.env, MUXEON_SHIM_REEXEC: "1" };
  for (const key of PROXY_VARS) delete env[key];
  const child = Bun.spawn({
    cmd: [process.execPath, ...process.argv.slice(1)],
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

/** The upstream operations the shim forwards — the structural subset of the SDK Client
 *  it relies on, so a fake (tests) need not be a full Client. */
export interface UpstreamClient {
  listTools(): Promise<ListToolsResult>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Opens a fresh upstream connection (a completed `initialize`), or throws (server down,
 *  identity rejected). Injectable so the reconnect logic is testable without a network. */
export type Connect = () => Promise<UpstreamClient>;

/**
 * A self-healing upstream connection. Holds at most one live client; on a failure it
 * drops the client and reconnects on the next use (FR-89). `run` retries a failed call
 * exactly once against a fresh connection — enough to ride out a server restart (the old
 * session 404s, the reconnect re-initializes), bounded so a genuinely-down server fails
 * fast instead of looping. `onReady` fires when a connection is (re)established after a
 * gap — the wiring uses it to refresh the agent's tool list.
 */
export class Upstream {
  readonly #connect: Connect;
  readonly #onReady: (() => void) | undefined;
  readonly #onError: ((reason: string) => void) | undefined;
  #client: UpstreamClient | null = null;
  #connecting: Promise<UpstreamClient> | null = null;
  /** True while we have no live connection — the next success is a recovery worth signalling. */
  #degraded = true;

  constructor(opts: {
    connect: Connect;
    onReady?: () => void;
    onError?: (reason: string) => void;
  }) {
    this.#connect = opts.connect;
    this.#onReady = opts.onReady;
    this.#onError = opts.onError;
  }

  #ensure(): Promise<UpstreamClient> {
    if (this.#client !== null) return Promise.resolve(this.#client);
    if (this.#connecting === null) {
      this.#connecting = this.#connect()
        .then((client) => {
          this.#client = client;
          if (this.#degraded) this.#onReady?.(); // a gap just closed — prompt a re-list
          this.#degraded = false;
          return client;
        })
        .catch((error) => {
          this.#degraded = true;
          this.#onError?.(error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => {
          this.#connecting = null;
        });
    }
    return this.#connecting;
  }

  #drop(client: UpstreamClient): void {
    if (this.#client === client) this.#client = null;
    this.#degraded = true;
    void client.close().catch(() => {}); // best-effort; a dead session can't be DELETEd
  }

  /** Run `fn` against a live upstream, reconnecting once if the live client fails. */
  async run<T>(fn: (client: UpstreamClient) => Promise<T>): Promise<T> {
    const client = await this.#ensure(); // a cold connect failure propagates (no retry)
    try {
      return await fn(client);
    } catch {
      this.#drop(client); // stale session / transport blip — re-initialize and retry once
      const fresh = await this.#ensure();
      return await fn(fresh);
    }
  }
}

/** The real upstream: an SDK Client that declares `name` as its topology identity at
 *  `initialize` (§8.6) and speaks Streamable HTTP to the agent-plane. */
export function httpConnect(name: string, url: string): Connect {
  return async () => {
    const client = new Client({ name, version: "0" });
    // Cast bridges an exactOptionalPropertyTypes mismatch in the SDK's concrete
    // transport (sessionId: string | undefined) — same as the test helper.
    await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);
    // Narrow the Client to the forwarded subset; callTool's SDK return is broader.
    return {
      listTools: () => client.listTools(),
      callTool: (args) => client.callTool(args) as Promise<CallToolResult>,
      close: () => client.close(),
    };
  };
}

const UNREACHABLE = "UPSTREAM_UNAVAILABLE";

/** A clean, retryable tool error when the agent-plane is unreachable — NOT a dead shim.
 *  The next call reconnects once the server is back. */
function unreachable(url: string, error: unknown): CallToolResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: `${UNREACHABLE}: muxeon agent-plane unreachable at ${url} (${reason}); it reconnects automatically — retry.`,
      },
    ],
    structuredContent: { error: UNREACHABLE },
    isError: true,
  };
}

/**
 * Build the shim's stdio Server over a (reconnecting) Upstream. tools/list serves the
 * last-known set during a momentary outage so the agent never sees an empty toolbox;
 * tools/call returns a clean retryable error when even a reconnect fails. Returns the
 * server plus `warmUp` — a background connect loop that keeps trying until the first
 * success (so a shim started before the server eventually surfaces the tools).
 */
export function buildShim(
  connect: Connect,
  url: string,
): { server: Server; warmUp: () => Promise<void> } {
  // Advertise tools.listChanged so we can prompt the agent's client to re-list on (re)connect.
  const server = new Server(
    { name: "muxeon-shim", version: "0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  let lastError: string | null = null;
  const upstream = new Upstream({
    connect,
    onReady: () => {
      void server.sendToolListChanged().catch(() => {});
    },
    onError: (reason) => {
      // Dedup: a down server retries forever; log only when the reason changes.
      if (reason === lastError) return;
      lastError = reason;
      process.stderr.write(`muxeon-shim: upstream connect failed — ${reason}\n`);
    },
  });

  let toolCache: ListToolsResult | null = null;
  const refreshTools = async (): Promise<ListToolsResult> => {
    const list = await upstream.run((client) => client.listTools());
    lastError = null;
    toolCache = list;
    return list;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await refreshTools();
    } catch (error) {
      if (toolCache !== null) return toolCache; // outage: serve the last-known §8.6 set
      throw error; // never connected — surface it (the agent's client shows the failure)
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await upstream.run((client) =>
        client.callTool({
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        }),
      );
    } catch (error) {
      return unreachable(url, error);
    }
  });

  const warmUp = async (): Promise<void> => {
    for (let delayMs = 500; ; delayMs = Math.min(delayMs * 2, 5000)) {
      try {
        await refreshTools();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };

  return { server, warmUp };
}

async function main(agentName: string, url: string): Promise<void> {
  const { server, warmUp } = buildShim(httpConnect(agentName, url), url);
  // Start serving stdio FIRST so the agent's client always has the server, even when the
  // agent-plane is down; then warm the upstream up in the background (FR-89).
  await server.connect(new StdioServerTransport());
  void warmUp();
}

if (import.meta.main) {
  const name = process.env.MUXEON_AGENT_NAME;
  const url = process.env.MUXEON_MCP_URL ?? "http://127.0.0.1:8080/mcp";
  if (name === undefined || name === "") {
    process.stderr.write("muxeon-shim: MUXEON_AGENT_NAME is required (the topology name, §8.6)\n");
    process.exit(1);
  }
  await main(name, url);
}
