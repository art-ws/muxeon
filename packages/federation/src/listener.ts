// The federation listener (§18.7, FR-138): the SEPARATE incoming surface —
// `federation.port`, loopback by default, reverse-proxy in front for the open
// network (§12.6 rules). Every request authenticates by bearer token BEFORE
// touching anything (class §10.12); the token names the importer (`accept[].name`
// — the suffix its inbound `from`s get, §10.24). Unauthenticated callers learn
// nothing, including whether a name exists.

import { createHash, timingSafeEqual } from "node:crypto";
import type { StatusProjection } from "@teamai/core";
import {
  FED_ACTORS_PATH,
  FED_HANDSHAKE_PATH,
  FED_LINK_PATH,
  FED_PROTOCOL_VERSION,
  type FedActorEntry,
  type HandshakeRequest,
} from "./protocol";

export interface FederationListenerOptions {
  readonly port: number;
  readonly bind?: string;
  readonly instanceId: string;
  /** `relay` (§18.11/FR-152): consent to relay this importer's published surface. */
  readonly accepts: readonly {
    readonly name: string;
    readonly token: string;
    readonly relay?: boolean;
  }[];
  /** §18.4/FR-149: announced in the handshake so an importer knows why `unknown`. */
  readonly statusPublished: boolean;
  readonly surface: () => readonly FedActorEntry[];
  readonly statuses: () => readonly StatusProjection[];
  /**
   * A link WS came up for `accept` — the manager attaches it and sends the
   * snapshot. The returned handle identifies THIS connection in onClose/
   * onMessage, so a stale socket's close never detaches its replacement.
   */
  readonly onOpen: (accept: string, send: (text: string) => void) => unknown;
  readonly onClose: (accept: string, handle: unknown) => void;
  readonly onMessage: (accept: string, raw: unknown, handle: unknown) => void;
  /** A valid handshake arrived (§18.11.5) — the satellite's declared intent. */
  readonly onHandshake?: (accept: string, request: HandshakeRequest) => void;
  readonly warn?: (message: string) => void;
}

/** Constant-time token comparison — hash first so lengths never leak (§12.6 class). */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface WsData {
  accept: string;
  handle?: unknown;
}

export class FederationListener {
  readonly #options: FederationListenerOptions;
  #server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: FederationListenerOptions) {
    this.#options = options;
  }

  /** The bound port (0 in config ⇒ ephemeral; read it back here). */
  get port(): number {
    return this.#server?.port ?? this.#options.port;
  }

  /** The accept entry behind the bearer, or null. Auth precedes everything (§10.12). */
  #identify(req: Request): FederationListenerOptions["accepts"][number] | null {
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    for (const accept of this.#options.accepts) {
      if (tokenMatches(token, accept.token)) return accept;
    }
    return null;
  }

  start(): void {
    const options = this.#options;
    this.#server = Bun.serve({
      port: options.port,
      hostname: options.bind ?? "127.0.0.1",
      idleTimeout: 0, // the link WS is long-lived by design (§18.7)
      fetch: async (req, server) => {
        const url = new URL(req.url);
        const accept = this.#identify(req);
        if (accept === null) return json({ error: "authentication required" }, 401);
        if (url.pathname === FED_HANDSHAKE_PATH && req.method === "POST") {
          let request: HandshakeRequest;
          try {
            request = (await req.json()) as HandshakeRequest;
          } catch {
            return json({ error: "malformed handshake" }, 400);
          }
          if (request.version !== FED_PROTOCOL_VERSION) {
            // Incompatibility is an explicit refusal with both numbers — the
            // client logs it and stays down (§18.7), nobody guesses.
            return json({ error: "protocol version mismatch", version: FED_PROTOCOL_VERSION }, 409);
          }
          // §18.11.5: the mode negotiation — the satellite declares, the hub
          // answers with its per-accept consent; a mismatch is the CLIENT's warn.
          options.onHandshake?.(accept.name, request);
          return json({
            instanceId: options.instanceId,
            version: FED_PROTOCOL_VERSION,
            statusPublished: options.statusPublished,
            relay: accept.relay === true,
          });
        }
        if (url.pathname === FED_ACTORS_PATH && req.method === "GET") {
          // The surface + the current snapshot in one read (§18.7) — entries
          // carry their projections when published.
          return json({ actors: options.surface() });
        }
        if (url.pathname === FED_LINK_PATH) {
          if (server.upgrade(req, { data: { accept: accept.name } })) return undefined;
          return json({ error: "websocket upgrade required" }, 400);
        }
        return json({ error: "not found" }, 404);
      },
      websocket: {
        open: (ws) => {
          const data = ws.data as WsData;
          data.handle = options.onOpen(data.accept, (text) => ws.send(text));
        },
        close: (ws) => {
          const data = ws.data as WsData;
          options.onClose(data.accept, data.handle);
        },
        message: (ws, message) => {
          const data = ws.data as WsData;
          options.onMessage(data.accept, message, data.handle);
        },
      },
    });
  }

  async stop(): Promise<void> {
    await this.#server?.stop(true);
    this.#server = null;
  }
}
