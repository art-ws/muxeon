// Minimal web connector (T37/S, FR-24b, §3.2): an HTTP/webhook connector behind
// the same unified interface — a full chat UI is a later extension on top of it.
// Inbound: POST {text, id?} to this connector's own listener (optionally guarded
// by a shared secret header) → @agent/defaultTarget addressing → router; the HTTP
// response carries the queued id or a clear error (§3.2). Outbound deliver: a
// webhook POST to the configured deliverUrl with {from, text, blobs} — blob refs
// stay OPAQUE ids (§5.3); byte transfer is part of the chat-UI extension. With no
// deliverUrl, deliver throws and the operator's queue simply accumulates
// (at-least-once §10.9; inspect/cancel via the operator-plane §8.5).

import type { Message } from "@teamai/core";
import { resolveTarget } from "./address";
import {
  type ChannelConnector,
  type InboundHandler,
  normalizePayload,
  operatorErrorText,
} from "./contract";

export interface WebConnectorOptions {
  readonly bindOperator: string;
  readonly defaultTarget?: string;
  /** Inbound listener port (0 = ephemeral; see `port` after start). */
  readonly port: number;
  /** Outbound webhook URL; absent ⇒ deliveries queue until one is configured. */
  readonly deliverUrl?: string;
  /** Shared secret: inbound must carry it in the x-teamai-secret header ($env, §7.3). */
  readonly secret?: string;
  readonly knownAgents: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly newId?: () => string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export class WebConnector implements ChannelConnector {
  readonly type = "web";
  readonly bindOperator: string;
  readonly defaultTarget?: string;
  readonly #options: WebConnectorOptions;
  readonly #knownAgents: ReadonlySet<string>;
  #server: ReturnType<typeof Bun.serve> | undefined;
  #onInbound: InboundHandler | undefined;

  constructor(options: WebConnectorOptions) {
    this.bindOperator = options.bindOperator;
    if (options.defaultTarget !== undefined) this.defaultTarget = options.defaultTarget;
    this.#options = options;
    this.#knownAgents = new Set(options.knownAgents);
  }

  /** The bound inbound port (after start). */
  get port(): number {
    return this.#server?.port ?? this.#options.port;
  }

  async start(onInbound: InboundHandler): Promise<void> {
    if (this.#server !== undefined) throw new Error("web connector already started");
    this.#onInbound = onInbound;
    this.#server = Bun.serve({
      port: this.#options.port,
      fetch: (req) => this.handleInbound(req),
    });
  }

  async stop(): Promise<void> {
    await this.#server?.stop(true);
    this.#server = undefined;
  }

  /** Inbound webhook handler (exposed for in-process tests, like the admin plane). */
  async handleInbound(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const secret = this.#options.secret;
    if (secret !== undefined && req.headers.get("x-teamai-secret") !== secret) {
      return json({ error: "invalid secret" }, 401);
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await req.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "body must be a JSON object" }, 400);
    }
    const text = body.text;
    if (typeof text !== "string" || text.length === 0) {
      return json({ error: '"text" (non-empty string) is required' }, 400);
    }
    const resolved = resolveTarget(text, this.#knownAgents, this.defaultTarget);
    if (!resolved.ok) {
      return json(
        { error: "no recipient — address an agent with @name (no default target is set)" },
        422,
      );
    }
    const message: Message = {
      // The caller may supply its retry id (§5.3/§10.9); otherwise one is generated.
      id:
        typeof body.id === "string" && body.id.length > 0
          ? body.id
          : (this.#options.newId ?? crypto.randomUUID.bind(crypto))(),
      from: this.bindOperator,
      to: resolved.target,
      kind: "message",
      ts: (this.#options.now ?? Date.now)(),
      payload: text,
      origin: "web",
    };
    const onInbound = this.#onInbound;
    if (onInbound === undefined) return json({ error: "connector not started" }, 503);
    try {
      await onInbound(message);
    } catch (error) {
      return json({ error: operatorErrorText(error) }, 422); // §3.2, redacted (§8.7)
    }
    return json({ queued: true, id: message.id, to: message.to });
  }

  /** Egress sink (§8.4): webhook POST. Throw = the record stays queued (§10.9). */
  async deliver(message: Message): Promise<void> {
    const url = this.#options.deliverUrl;
    if (url === undefined) {
      throw new Error("no deliverUrl configured — outbound web delivery is queued");
    }
    const payload = normalizePayload(message.payload);
    const response = await (this.#options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        from: message.from,
        kind: message.kind,
        ...(payload.text !== undefined ? { text: payload.text } : {}),
        ...(payload.blobs.length > 0 ? { blobs: payload.blobs } : {}), // opaque refs (§5.3)
      }),
    });
    if (!response.ok) throw new Error(`web deliver failed: HTTP ${response.status}`);
  }
}
