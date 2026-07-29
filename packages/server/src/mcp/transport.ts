// Agent-plane transport (§8.1): MCP over Streamable HTTP on server.port, served by
// Bun.serve. Each agent gets one MCP session; identity is bound at initialize (§8.6,
// see identity.ts) and the 4 tools are supplied per-session by the injected makeServer
// factory (the tools live in tools.ts, T22 — this module owns only the protocol,
// sessions, and identity gate). The WebStandard transport speaks Fetch Request/Response,
// the SDK's recommended shape for bun.

import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type IdentityRejection, SessionRegistry, parseInitialize } from "./identity";

export interface AgentPlaneCoreOptions {
  /** Per-session MCP Server bound to the caller identity — the 4 tools (T22). */
  readonly makeServer: (caller: string) => Server;
  /** Whether a name is a known agent/operator (§8.6); unknown → initialize rejected. */
  readonly isKnownIdentity: (name: string) => boolean;
  /**
   * Surfaced on identity takeover (FR-44b): a new initialize evicted `oldSession`'s
   * binding for `name`. Wire to a log — a genuine duplicate-name misconfiguration
   * shows up here (the evicted client also starts getting `unknown session`).
   */
  readonly onEviction?: (name: string, oldSession: string) => void;
}

export interface AgentPlaneOptions extends AgentPlaneCoreOptions {
  readonly port: number;
  /** Mount path; default "/mcp". */
  readonly path?: string;
}

/** Path-agnostic agent-plane handler — the mount (own listener or the shared
 *  surface, §8.1) decides where it lives. */
export interface AgentPlaneCore {
  fetch(req: Request): Promise<Response>;
  /** Drop all sessions (listener teardown). */
  dispose(): void;
}

export interface AgentPlaneHandle {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

// A JSON-RPC error echoing the initialize id, returned at HTTP 200 so the SDK client
// surfaces OUR named reason instead of a generic HTTP failure.
function rejectInitialize(id: string | number | null, reason: IdentityRejection): Response {
  const message = "unknown agent identity (not a configured agent or operator)";
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message, data: { reason } } }),
    { status: 200, headers: JSON_HEADERS },
  );
}

/**
 * Build the agent-plane core: MCP protocol, sessions, identity gate — without a
 * listener. Gated by the caller (server.mcp, §8.1): when mcp is false this is
 * simply never invoked.
 */
export function createAgentPlaneCore(options: AgentPlaneCoreOptions): AgentPlaneCore {
  const registry = new SessionRegistry(options.isKnownIdentity);
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const handlePost = async (req: Request, sessionId: string | undefined): Promise<Response> => {
    const bodyText = await req.text();
    const rebuilt = (): Request =>
      new Request(req.url, { method: "POST", headers: req.headers, body: bodyText });

    if (sessionId !== undefined) {
      const transport = transports.get(sessionId);
      if (transport === undefined) return new Response("unknown session", { status: 404 });
      return transport.handleRequest(rebuilt());
    }

    // No session id ⇒ this must be initialize; bind the declared identity first (§8.6).
    const init = parseInitialize(bodyText);
    if (init === null || init.name === undefined) {
      return new Response("expected initialize with clientInfo.name", { status: 400 });
    }
    const reservation = registry.reserve(init.name);
    if (reservation === "UNKNOWN_IDENTITY") return rejectInitialize(init.id, reservation);
    if (reservation.evictedSession !== undefined) {
      // Takeover (FR-44b): the previous binding is presumed dead (a crashed client
      // never sends DELETE). Drop its transport — its next request gets 404.
      transports.delete(reservation.evictedSession);
      options.onEviction?.(init.name, reservation.evictedSession);
    }

    const name = init.name;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        registry.bind(id, name);
        transports.set(id, transport);
      },
      onsessionclosed: (id) => {
        registry.drop(id);
        transports.delete(id);
      },
    });
    try {
      await options.makeServer(name).connect(transport);
      return await transport.handleRequest(rebuilt());
    } catch {
      if (transport.sessionId === undefined) registry.release(name); // never came up
      return new Response("initialize failed", { status: 500 });
    }
  };

  return {
    fetch: async (req) => {
      const sessionId = req.headers.get("mcp-session-id") ?? undefined;
      if (req.method === "POST") return handlePost(req, sessionId);
      // GET (SSE stream) / DELETE (terminate) operate on an existing session only.
      const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
      if (transport === undefined) return new Response("unknown session", { status: 404 });
      return transport.handleRequest(req);
    },
    // We deliberately do NOT call transport.close() per session — on the WebStandard
    // transport it awaits the SSE stream lifecycle and hangs at teardown. Normal
    // per-session cleanup runs via onsessionclosed when a client disconnects.
    dispose: () => {
      transports.clear();
    },
  };
}

/**
 * Start the agent-plane on its OWN listener. Production uses the shared surface
 * (one port, two planes — §8.1, see surface.ts); this standalone form serves the
 * transport-level unit tests.
 */
export function startAgentPlane(options: AgentPlaneOptions): AgentPlaneHandle {
  const path = options.path ?? "/mcp";
  const core = createAgentPlaneCore(options);
  const server = Bun.serve({
    port: options.port,
    idleTimeout: 0, // long-lived SSE streams must not be reaped
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      return core.fetch(req);
    },
  });

  const port = server.port ?? options.port;
  return {
    port,
    url: `http://localhost:${port}${path}`,
    stop: async () => {
      // server.stop(true) force-closes every connection (and thus each session's streams).
      core.dispose();
      await server.stop(true);
    },
  };
}
