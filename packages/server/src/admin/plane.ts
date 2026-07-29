// The operator-plane HTTP-admin (§8.1, §8.5, FR-4): REST/JSON on server.port under
// /admin — a separate path and privilege set from the MCP agent-plane (§10.10); the
// surface (surface.ts) enforces the loopback binding. Errors are operator-facing
// AdminErrors; anything unexpected is a generic 500 (no internals leak, §8.7).
//
// Routes (catalog §8.5):
//   GET    /admin/agents
//   POST   /admin/agents/<name>/(provision|kill|restart|shutdown|reload)
//   POST   /admin/agents/<name>/command                 {slash} → {output} (FR-66)
//   POST   /admin/agents/command                         {slash, selectors[]} → command-fanout (FR-115)
//   GET    /admin/channels
//   POST   /admin/signals/send
//   POST   /admin/blobs                                 raw bytes → {id, size} (FR-46)
//   GET    /admin/queues/<name>
//   POST   /admin/queues/<name>/(cancel|requeue)        {id}
//   GET    /admin/routines[?owner=]
//   GET    /admin/routines/<owner>/<id>
//   PUT    /admin/routines/<owner>/<id>                 {content}
//   DELETE /admin/routines/<owner>/<id>
//   POST   /admin/routines/<owner>/<id>/(enable|disable|run-once)

import type { CommandFanoutResult } from "@teamai/orchestrator";
import type { BlobsAdmin } from "./blobs";
import type { ChannelsAdmin } from "./channels";
import { AdminError } from "./error";
import type { LifecycleAdmin } from "./lifecycle";
import type { QueuesAdmin } from "./queues";
import type { RoutinesAdmin } from "./routines";
import type { SignalSendInput, SignalsAdmin } from "./signals";

export interface AdminDeps {
  readonly lifecycle: LifecycleAdmin;
  /**
   * Operator slash-command to the intersection of a set of selectors (§15.8,
   * FR-115). Pre-bound at assembly with the broadcast resolver + a per-agent
   * dispatcher; the plane just validates the request and serialises the result.
   */
  readonly commandFanout: (
    slash: string,
    selectors: readonly string[],
  ) => Promise<CommandFanoutResult>;
  readonly channels: ChannelsAdmin;
  readonly signals: SignalsAdmin;
  readonly queues: QueuesAdmin;
  readonly routines: RoutinesAdmin;
  /** Blob intake for signal attachments (§8.5, FR-46). */
  readonly blobs: BlobsAdmin;
  /** Boundary text scrubber (§8.7): applied to every operator-facing error message. */
  readonly redactText?: (text: string) => string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new AdminError(400, "request body must be JSON", "BAD_REQUEST");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AdminError(400, "request body must be a JSON object", "BAD_REQUEST");
  }
  return parsed as Record<string, unknown>;
}

function requireStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminError(400, `"${field}" (non-empty string) is required`, "BAD_REQUEST");
  }
  return value;
}

function requireStringArray(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === "string" && v.length > 0)
  ) {
    throw new AdminError(400, `"${field}" (non-empty string[]) is required`, "BAD_REQUEST");
  }
  return value as readonly string[];
}

export function createAdminHandler(deps: AdminDeps): (req: Request) => Promise<Response> {
  const route = async (req: Request, segments: readonly string[]): Promise<Response> => {
    const [section, ...rest] = segments;

    if (section === "agents") {
      if (req.method === "GET" && rest.length === 0) return json({ agents: deps.lifecycle.list() });
      // POST /admin/agents/command {slash, selectors[]} → slash-command to the
      // INTERSECTION of the selectors (§15.8, FR-115). Ordered before the
      // single-agent <name>/command route (rest.length === 2 can't match here).
      if (req.method === "POST" && rest.length === 1 && rest[0] === "command") {
        const body = await readJsonBody(req);
        const result = await deps.commandFanout(
          requireStringField(body, "slash"),
          requireStringArray(body, "selectors"),
        );
        if (!result.ok) throw new AdminError(400, result.message, result.code);
        return json(result);
      }
      const [name, action] = rest;
      if (req.method === "POST" && name !== undefined && rest.length === 2) {
        if (action === "provision") return json({ status: await deps.lifecycle.provision(name) });
        if (action === "kill") return json({ status: await deps.lifecycle.kill(name) });
        if (action === "restart") return json({ status: await deps.lifecycle.restart(name) });
        // graceful twins (FR-64): teardown strategy first, hard kill as fallback
        if (action === "shutdown") return json({ status: await deps.lifecycle.shutdown(name) });
        if (action === "reload") return json({ status: await deps.lifecycle.reload(name) });
        // configured slash command (FR-66) → captured console output as-is
        if (action === "command") {
          const slash = requireStringField(await readJsonBody(req), "slash");
          return json({ output: await deps.lifecycle.command(name, slash) });
        }
      }
    }

    if (section === "channels" && req.method === "GET" && rest.length === 0) {
      return json({ channels: deps.channels.list() });
    }

    if (section === "signals" && req.method === "POST" && rest[0] === "send" && rest.length === 1) {
      const body = await readJsonBody(req);
      return json(await deps.signals.send(body as unknown as SignalSendInput));
    }

    if (section === "blobs" && req.method === "POST" && rest.length === 0) {
      // Raw bytes, not JSON (FR-46) — the body IS the blob.
      const bytes = new Uint8Array(await req.arrayBuffer());
      return json(await deps.blobs.upload(bytes, req.headers.get("content-type") ?? undefined));
    }

    if (section === "queues") {
      const [name, action] = rest;
      if (req.method === "GET" && name !== undefined && rest.length === 1) {
        return json(await deps.queues.peek(name));
      }
      if (req.method === "POST" && name !== undefined && rest.length === 2) {
        const id = requireStringField(await readJsonBody(req), "id");
        if (action === "cancel") return json(await deps.queues.cancel(name, id));
        if (action === "requeue") return json(await deps.queues.requeue(name, id));
      }
    }

    if (section === "routines") {
      if (req.method === "GET" && rest.length === 0) {
        const owner = new URL(req.url).searchParams.get("owner") ?? undefined;
        return json({ routines: await deps.routines.list(owner) });
      }
      const [owner, id, action] = rest;
      if (owner !== undefined && id !== undefined) {
        if (rest.length === 2) {
          if (req.method === "GET") return json(await deps.routines.get(owner, id));
          if (req.method === "PUT") {
            const content = requireStringField(await readJsonBody(req), "content");
            return json(await deps.routines.put(owner, id, content));
          }
          if (req.method === "DELETE") return json(await deps.routines.delete(owner, id));
        }
        if (req.method === "POST" && rest.length === 3) {
          if (action === "enable") return json(await deps.routines.setEnabled(owner, id, true));
          if (action === "disable") return json(await deps.routines.setEnabled(owner, id, false));
          if (action === "run-once") return json(await deps.routines.runOnce(owner, id));
        }
      }
    }

    throw new AdminError(404, "no such operator-plane operation", "NOT_FOUND");
  };

  return async (req) => {
    const path = new URL(req.url).pathname;
    const segments = path
      .replace(/^\/admin\/?/, "")
      .split("/")
      .filter((s) => s.length > 0)
      .map(decodeURIComponent);
    try {
      return await route(req, segments);
    } catch (error) {
      if (error instanceof AdminError) {
        const redact = deps.redactText ?? ((text: string) => text);
        return json(
          {
            error: redact(error.message), // secrets scrubbed at the boundary (§8.7)
            ...(error.code !== undefined ? { code: error.code } : {}),
          },
          error.status,
        );
      }
      return json({ error: "internal error" }, 500); // no internals leak (§8.7)
    }
  };
}
