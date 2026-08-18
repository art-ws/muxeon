// Agent-side MCP shim (§8.6, FR-44/FR-89): a DURABLE stdio↔Streamable-HTTP proxy that
// lets a CLI agent join the agent-plane under its TOPOLOGY name. Native MCP clients of
// CLI agents (claude/openclaude) declare their own clientInfo.name (`claude-code`) and
// cannot be told to declare the agent's identity — so the agent's OWNER registers this
// shim as a stdio MCP server (e.g. in the workspace .mcp.json) and the shim performs the
// upstream `initialize` with clientInfo.name = MUXEON_AGENT_NAME. Registration is the
// owner's action in the agent's own config — Muxeon itself never touches agent
// configuration (FR-11b).
//
// DURABILITY (FR-89). The agent's stdio link to the shim is the stable contract; the
// upstream HTTP session is disposable. The shim NEVER holds a single long-lived session
// hostage: on ANY upstream failure — a server restart invalidates our session id (→ 404
// "unknown session"); a server still booting refuses the connection — it drops the dead
// client and RE-INITIALIZES. So a Muxeon server restart no longer severs agents: no
// `muxeon restart <agent>` needed. The proxy stays transparent: tools/list and tools/call
// are forwarded verbatim, so the agent sees exactly the §8.6 set and nothing here changes
// when the plane evolves.
//
// SUPERVISION (FR-158). Reconnecting on demand is not enough, because the session's
// liveness is itself a signal now: the coordinator picks the compact reply contract
// (§13.6, FR-156) only for agents holding a live agent-plane session. Repair driven by
// the next tool call therefore deadlocks — a server restart kills every session, the
// agent is handed the FILE contract, the file contract requires no MCP call, so nothing
// ever reconnects and the agent stays on the file path forever (found live on the T261
// deploy). Nothing pushes a notification either: the plane answers with plain JSON, so
// there is no stream whose close could be observed. Hence a background loop that keeps
// probing after the FIRST success, not only until it: one cheap tools/list per interval,
// which reconnects through the same path as any other call and re-registers the name.
//
// LIFETIME (T284). Because every probe re-registers the name, a shim that outlives its
// agent is not idle — it keeps CLAIMING the identity and evicting the live shim (FR-44b),
// which then reclaims it, forever. So the stdio link is also the shim's lifetime: when it
// closes, the process exits.
//
// Run: MUXEON_AGENT_NAME=<topology-name> bun packages/server/src/mcp/shim.ts
// Env: MUXEON_MCP_URL — agent-plane endpoint (default http://127.0.0.1:8080/mcp).
//      MUXEON_SHIM_PROBE_MS — supervision interval, default 30000; 0 disables probing
//      (the loop then stops at the first success, the pre-FR-158 warm-up behaviour).

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

/** Supervision knobs (FR-158); all injectable so the loop is testable without real time. */
export interface SuperviseOptions {
  /** Probe cadence after a successful connect; 0 ⇒ stop at the first success. */
  readonly probeMs?: number;
  /** Stops the loop (process shutdown, tests). */
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Supervision cadence (FR-158). 30s is far below any human-noticeable gap between a
 *  coordinator restart and the agent's next message, and costs one tiny request. */
export const DEFAULT_PROBE_MS = 30_000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the shim's stdio Server over a (reconnecting) Upstream. tools/list serves the
 * last-known set during a momentary outage so the agent never sees an empty toolbox;
 * tools/call returns a clean retryable error when even a reconnect fails. Returns the
 * server plus `supervise` — the background loop of FR-158: it connects (so a shim started
 * before the server eventually surfaces the tools) and then KEEPS probing, so a session
 * killed by a coordinator restart is restored without the agent having to call anything.
 */
export function buildShim(
  connect: Connect,
  url: string,
): { server: Server; supervise: (options?: SuperviseOptions) => Promise<void> } {
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

  const supervise = async (options: SuperviseOptions = {}): Promise<void> => {
    const probeMs = options.probeMs ?? DEFAULT_PROBE_MS;
    const sleep = options.sleep ?? defaultSleep;
    let retryMs = RETRY_MIN_MS;
    while (options.signal?.aborted !== true) {
      try {
        // The probe IS the repair: refreshTools goes through Upstream.run, which on a
        // stale session drops the dead client, re-initializes (re-registering the name,
        // §8.6) and retries — the same path a real tool call takes. A healthy upstream
        // just answers, so the steady state costs one tools/list per interval.
        await refreshTools();
        if (probeMs <= 0) return; // probing disabled — first success ends the loop
        retryMs = RETRY_MIN_MS;
        await sleep(probeMs);
      } catch {
        // Backoff applies only to the unreachable case: a server that is down stays down
        // for a while, and hammering it changes nothing. The failure was already logged
        // (deduped) by the Upstream onError hook.
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  };

  return { server, supervise };
}

/** MUXEON_SHIM_PROBE_MS → cadence; a non-numeric or negative value falls back to the
 *  default rather than silently disabling supervision (0 disables it explicitly). */
export function probeMsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROBE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PROBE_MS;
  return parsed;
}

/**
 * The agent's stdio link is the shim's whole reason to exist, so when it closes the
 * shim must GO (T284). A survivor keeps probing (FR-158), and every probe RE-REGISTERS
 * the agent's name upstream, so the coordinator hands the identity to it and evicts
 * whoever held it (FR-44b) — the live shim of the restarted agent and the ghost of the
 * dead one then take the name from each other forever. Found live on dev1: four
 * claimants (three orphaned by earlier sessions, PPID 1) producing ~16 evictions a
 * minute, and a §13.6 reply-contract choice that could read a ghost's session as
 * "this agent is on MCP".
 */
export function exitWhenAgentGone(server: { onclose?: () => void }, stop: () => void): void {
  const previous = server.onclose;
  server.onclose = (): void => {
    previous?.();
    stop();
  };
}

async function main(agentName: string, url: string, probeMs: number): Promise<void> {
  const { server, supervise } = buildShim(httpConnect(agentName, url), url);
  const gone = new AbortController();
  exitWhenAgentGone(server, () => {
    gone.abort(); // stop probing, then leave: there is no agent left to serve
    process.exit(0);
  });
  // Start serving stdio FIRST so the agent's client always has the server, even when the
  // agent-plane is down; then supervise the upstream in the background (FR-89/FR-158).
  await server.connect(new StdioServerTransport());
  void supervise({ probeMs, signal: gone.signal });
}

if (import.meta.main) {
  const name = process.env.MUXEON_AGENT_NAME;
  const url = process.env.MUXEON_MCP_URL ?? "http://127.0.0.1:8080/mcp";
  if (name === undefined || name === "") {
    process.stderr.write("muxeon-shim: MUXEON_AGENT_NAME is required (the topology name, §8.6)\n");
    process.exit(1);
  }
  await main(name, url, probeMsFromEnv(process.env.MUXEON_SHIM_PROBE_MS));
}
