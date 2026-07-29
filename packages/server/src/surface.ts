// The shared network surface (§8.1): both planes on ONE server.port, separated by
// path and privilege (§10.10) — the MCP agent-plane at /mcp (present only when
// server.mcp is on), the operator-plane HTTP-admin under /admin. The admin plane is
// bound to loopback by default: the surface rejects any /admin request whose peer
// is not a loopback address (remote operator access — OOS-9). This is a path/
// loopback separation, not crypto protection from a malicious local process —
// documented boundary, §8.7/§10.10.

export interface SurfaceOptions {
  readonly port: number;
  /** Agent-plane fetch handler, mounted at /mcp; absent ⇒ mcp:false (no agent-plane). */
  readonly mcp?: (req: Request) => Promise<Response>;
  /** Operator-plane fetch handler, mounted under /admin (loopback-only). */
  readonly admin: (req: Request) => Promise<Response>;
}

export interface ServerSurface {
  readonly port: number;
  /** /mcp endpoint URL when the agent-plane is mounted. */
  readonly mcpUrl?: string;
  readonly adminUrl: string;
  stop(): Promise<void>;
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

export function startSurface(options: SurfaceOptions): ServerSurface {
  const server = Bun.serve({
    port: options.port,
    idleTimeout: 0, // long-lived MCP SSE streams must not be reaped
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/mcp") {
        if (options.mcp === undefined) return new Response("not found", { status: 404 });
        return options.mcp(req);
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        if (!isLoopback(srv.requestIP(req)?.address)) {
          return new Response("operator-plane is loopback-only (§8.1)", { status: 403 });
        }
        return options.admin(req);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port ?? options.port;
  let stopped = false;
  return {
    port,
    ...(options.mcp !== undefined ? { mcpUrl: `http://localhost:${port}/mcp` } : {}),
    adminUrl: `http://localhost:${port}/admin`,
    stop: async () => {
      if (stopped) return; // idempotent: bootstrap.stop and handle views may both call
      stopped = true;
      await server.stop(true);
    },
  };
}
