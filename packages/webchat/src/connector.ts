// WebchatConnector (T44/T46, FR-38/FR-40/FR-42, §12): the operator web panel's
// HTTP surface on its OWN port (§12.2 — never server.port), behind the same
// ChannelConnector contract as telegram/slack (§8.4). The surface: auth (login →
// httpOnly cookie, Origin check, login rate-limit), POST /api/send → router,
// GET /api/peers + /api/history/:agent + POST /api/read + GET /api/transport
// (FR-48), and WS /api/ws pushing message | status | ack | queue-progress |
// transport (§12.4). Blobs (T47) and the SPA statics (T49) mount on this same
// surface later.
//
// §10.12 ordering is structural here: handleRequest authenticates BEFORE any
// route dispatch — an unauthenticated request never reaches onInbound (the
// router bridge), the history, or the dynamics ports.
//
// Outbound: deliver() appends to the durable history (T45, §12.3) — that IS the
// delivery: a connected browser is not required, it reads the tail on reconnect.
// With no history wired (tests) deliver throws, so the operator's pseudo-session
// queue simply accumulates (at-least-once §10.9) — nothing is lost.
//
// Dynamics (§12.7): a light poll loop over the injected read-only ports turns
// status / queue-depth / message-phase changes into WS events. Observation only —
// the panel never moves queue records (§10.8).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type BlobRef,
  type ChannelConnector,
  type InboundHandler,
  normalizePayload,
  operatorErrorText,
} from "@muxeon/channels";
import type { AgentStatus, Message, Signal } from "@muxeon/core";
import {
  LoginRateLimiter,
  type PasswordVerifier,
  type RateLimitOptions,
  SessionStore,
  verifyPassword,
} from "./auth";
import { ConsoleLineBuffer } from "./console-input";
import type { HistoryStore } from "./history";
import type {
  ConsoleAttachment,
  MessagePhase,
  TransportObservability,
  WebchatLifecycle,
  WebchatPorts,
  WebchatRole,
} from "./ports";
import { PromptError, type PromptLibrary, type PromptStore } from "./prompts";
import type { ReactionView, ReactionsHub } from "./reactions";

export const SESSION_COOKIE = "muxeon_webchat";

/** Byte store under <root>/blobs/ (§5.3) — orchestrator's BlobStore, structurally. */
export interface WebchatBlobStore {
  /** Write bytes as a new blob (tmp+rename); returns the OPAQUE id (§5.3).
   *  The hint (T117) lets the store suffix the stored file with its extension. */
  write(
    bytes: Uint8Array,
    hint?: { readonly name?: string | undefined; readonly mime?: string | undefined },
  ): Promise<string>;
  /** Read by an UNTRUSTED id with realpath-containment (§8.7, §10.11). */
  read(id: string): Promise<Uint8Array>;
}

/** Upload bounds (§12.5, config `upload` §12.2) with the spec-sample defaults. */
export interface UploadLimits {
  readonly maxBytes?: number;
  readonly mime?: readonly string[];
}

export const UPLOAD_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_DEFAULT_MIME = [
  "image/*",
  "audio/*",
  "video/*",
  "application/pdf",
  "text/*",
] as const;

/** Media types rendered inline in the chat; everything else downloads (§12.6). */
const INLINE_MIME_PREFIXES = ["image/", "audio/", "video/"];

/** WS push events (§12.4). */
export type WebchatEvent =
  | { readonly type: "message"; readonly record: Signal }
  | { readonly type: "transport"; readonly record: Signal }
  | { readonly type: "ack"; readonly id: string; readonly to: string }
  | { readonly type: "history-cleared"; readonly peer: string }
  | {
      /** A message's reactions changed (§19.5, FR-162) — the folded state, not a delta. */
      readonly type: "reaction";
      readonly peer: string;
      readonly messageId: string;
      readonly reactions: readonly ReactionView[];
    }
  | {
      /**
       * An agent↔agent record's reactions changed (§19.13, FR-182) — the journal
       * row's folded state. Admin tabs only, like the journal itself, and
       * `mine` is always false: nobody reacts FROM the journal.
       */
      readonly type: "transport-reaction";
      readonly messageId: string;
      readonly reactions: readonly ReactionView[];
    }
  | {
      readonly type: "status";
      readonly peer: string;
      /** Session status (§5.1); a federated peer may read "unknown" (§18.4/§10.27). */
      readonly status?: AgentStatus | "unknown" | undefined;
      /** Operator-declared pause (§16, FR-119) — orthogonal to `status` (§16.1). */
      readonly paused: boolean;
      readonly queueDepth: number;
      /** Queue depth has reached the agent's WIP cap (FR-104) — red name in the panel. */
      readonly atWipLimit: boolean;
      /** Has an outgoing rendezvous intent — "я жду" / ↑ (FR-105). */
      readonly waiting: boolean;
      /** Is the target of a rendezvous intent — "меня ждут" / ↓ (FR-105). */
      readonly awaited: boolean;
      /** Presence of a user peer (§17.5, FR-133); absent for agents. */
      readonly presence?: string;
      /** Federated peer only (§18.4, FR-150): its import name. */
      readonly server?: string;
      /** Federated peer only (FR-139/FR-140): link reachability. */
      readonly link?: "up" | "down";
      /** Federated peer only (§18.4): why the projection reads `unknown`. */
      readonly reason?: "link-down" | "not-published" | "hop-down";
    }
  | {
      readonly type: "queue-progress";
      readonly id: string;
      readonly to: string;
      readonly phase: MessagePhase;
    };

/**
 * One panel user in users mode (§17.2/§17.4, FR-121/FR-127). Everything that used
 * to be channel-wide — the password, the session store, the history, the read-only
 * ports and the lifecycle port — becomes per-user here, which is what makes the
 * §10.22 isolation STRUCTURAL: a request is served from its own user's objects, so
 * another user's data is not merely forbidden, it is unreachable.
 */
export interface WebchatUserOptions {
  readonly name: string;
  /** Display label in the panel (§7.1/§17.2, FR-156); absent ⇒ the name is shown. */
  readonly title?: string;
  readonly color?: string;
  /** Panel role (§17.7, FR-131) — only `admin` sees the transport journal. */
  readonly role: WebchatRole;
  /** Literal / `$env`-resolved password (FR-122). Exactly one of the two. */
  readonly password?: string;
  /** Inline argon2id/bcrypt hash (FR-122). Exactly one of the two. */
  readonly passwordHash?: string;
  /** Durable per-user sessions: `<config_dir>/webchat/sessions/<user>.json` (§17.4). */
  readonly session?: { readonly ttlMs?: number; readonly renewMs?: number; readonly file?: string };
  /** The user's own chat log (§12.3 layout, keyed by the user — §17.7). */
  readonly history: HistoryStore;
  /** Read-only dynamics ports scoped to THIS user's neighbours (§10.2). */
  readonly ports?: WebchatPorts;
  /** Narrow lifecycle port scoped to THIS user's neighbours (FR-129). */
  readonly lifecycle?: WebchatLifecycle;
}

export interface WebchatConnectorOptions {
  /**
   * Legacy single-operator binding (§12.1). Absent in users mode (§17.2) — the
   * identities then come from `users`, and every surface is per-user (FR-127).
   */
  readonly bindOperator?: string | undefined;
  /**
   * Users mode (§17.2, FR-127): the configured panel users. Mutually exclusive
   * with `bindOperator` — the config validator (§17.3) rejects both at once.
   */
  readonly users?: readonly WebchatUserOptions[];
  /** Panel listener port (§12.2); 0 = ephemeral (tests; see `port` after start). */
  readonly port: number;
  /** Listen address; default loopback — the internet path goes through a reverse-proxy (§12.6). */
  readonly bind?: string;
  /**
   * URL prefix the WHOLE surface mounts under (T120, §12.2) — statics, /api and
   * the WS alike, e.g. "/team". Validated by the §12.2 config rules ("/"-led
   * segments, no trailing slash); absent ⇒ the root, exactly as before. The SPA
   * is prefix-agnostic by construction (relative URLs only, §12.6), so the
   * server side is the whole feature: requests outside the prefix are 404,
   * "<prefix>" redirects to "<prefix>/" so those relative URLs resolve.
   */
  readonly basePath?: string;
  /** Operator password, already $env-resolved (§7.3). Legacy mode only (§17.2). */
  readonly password?: string;
  /**
   * Durable TTL sessions (§12.6, FR-57): `file` persists hashed tokens across
   * restarts, `ttlMs` bounds their life (default 1d) and feeds the cookie's
   * Max-Age. `renewMs` (T125, FR-86) is the sliding-renewal extension (default
   * ttl) — POST /api/session/renew pushes the expiry that far forward. Absent
   * ⇒ in-memory sessions (a restart logs out).
   */
  readonly session?: { readonly ttlMs?: number; readonly renewMs?: number; readonly file?: string };
  /** Durable chat log (§12.3); absent ⇒ deliver throws and the queue accumulates (§10.9). */
  readonly history?: HistoryStore;
  /** Read-only dynamics ports (§12.4); absent ⇒ empty peer list, no pushes. */
  readonly ports?: WebchatPorts;
  /** Transport observability (FR-48, §12.4); absent ⇒ /api/transport answers 503. */
  readonly transport?: TransportObservability;
  /** Narrow lifecycle port (FR-65, §12.4); absent ⇒ /api/agents/* answers 503, no buttons. */
  readonly lifecycle?: WebchatLifecycle;
  /** Blob store (§12.5); absent ⇒ media endpoints answer 503. */
  readonly blobs?: WebchatBlobStore;
  /**
   * Reactions (§19, FR-161…FR-168): the one hub both this surface and the
   * agent-plane `react` tool go through, so they share idempotency, mirroring and
   * notification rules. Absent (or with an empty catalog) ⇒ the endpoints answer
   * REACTIONS_DISABLED and the panel renders no picker.
   */
  readonly reactions?: ReactionsHub;
  /**
   * Prompt library (§20, FR-183/FR-184): the per-user rack of reusable prompts.
   * One store for every owner — it keys files by the signed-in name, which is why
   * no path here carries an owner. Absent ⇒ `/api/prompts*` answers 503 and the
   * panel offers neither the composer items nor the page.
   */
  readonly prompts?: PromptStore;
  /** Built SPA dir (§12.7, the @muxeon/webchat-ui dist); absent ⇒ non-API 404. */
  readonly staticDir?: string;
  /**
   * Instance label (FR-90, §12.7): injected into the served shell as
   * `<title><name> - Muxeon</title>` and `<meta name="muxeon-name">` (the topbar
   * reads the meta). Already defaulted to hostname() by the caller; absent
   * (tests) ⇒ the shell is served verbatim (title stays "Muxeon").
   */
  readonly instanceName?: string;
  /**
   * Server build info (FR-91, §12.4) for the Settings footer — version + the
   * deployed commit and its date. Served by `GET /api/server` BEHIND the auth gate
   * (version disclosure is not public, unlike the instance label); absent ⇒ 503.
   */
  readonly serverInfo?: {
    readonly version: string;
    readonly commit?: string;
    readonly builtAt?: string;
  };
  /** Upload caps (§12.5); defaults: 25 MiB, media/pdf/text allowlist. */
  readonly upload?: UploadLimits;
  /** Dynamics poll cadence, ms (NFR-10 spirit: cheap readdir/status reads). */
  readonly pollMs?: number;
  /** Post-delivery hook (tests); the WS push happens regardless. */
  readonly onDelivered?: (signal: Signal) => void;
  readonly loginRate?: RateLimitOptions;
  readonly now?: () => number;
  readonly newToken?: () => string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Operator-visible warning (same stderr idiom as the user push fan-out, §17.5). */
const warn = (message: string): void => {
  process.stderr.write(`muxeon: warning: ${message}\n`);
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/**
 * Static caching (T282, §12.6): every SPA answer carries a validator and
 * `no-cache`. Not "do not cache" — "cache, but ASK before using": the entry
 * bundle keeps a stable name (`assets/main.js`, §12.7), so without a validator a
 * browser may keep serving yesterday's panel after a soft reload and a deployed
 * fix looks undeployed (the lesson of T280/T281). Revalidation is a header
 * round-trip against a local server, and an unchanged file comes back as a 304
 * with no body.
 */
const cacheHeaders = (etag: string): Record<string, string> => ({
  etag,
  "cache-control": "no-cache",
});

/** Does the client already hold this exact version? `If-None-Match` may list several. */
const isFresh = (req: Request | undefined, etag: string): boolean => {
  const header = req?.headers.get("if-none-match");
  if (header === null || header === undefined) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === etag || candidate === "*");
};

/** 304: the validator repeats, the body does not (RFC 9110 §15.4.5). */
const notModified = (etag: string): Response =>
  new Response(null, { status: 304, headers: cacheHeaders(etag) });

/** The minimal WS client surface the connector needs (Bun's ServerWebSocket). */
interface WsClient {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes still queued for this socket (Bun) — the console's backpressure valve. */
  getBufferedAmount?(): number;
  /** Which identity's tabs this socket belongs to (§10.22) — set at upgrade. */
  data?: unknown;
}

/** Upgrade payload of a console socket (§12.9, FR-160): whose tab, which agent. */
interface ConsoleSocketData {
  readonly owner: string;
  readonly console: string;
}

/** Server-side state of one open console (§12.9) — one socket, one attachment. */
interface ConsoleSocketState {
  attachment: ConsoleAttachment | undefined;
  closed: boolean;
  /** Keystrokes typed between the upgrade and the attach — replayed in order. */
  pending: Uint8Array[];
  /** Reconstruction of what this socket's human typed (§12.9.6, FR-170). */
  readonly line: ConsoleLineBuffer;
}

/** A single input frame is capped: a console is a keyboard, not an upload path. */
const CONSOLE_INPUT_MAX_BYTES = 64 * 1024;

/**
 * Output already queued for a browser, beyond which further pane bytes are
 * DROPPED (§12.9). A runaway pane (`yes`, a cat of a huge file) produces faster
 * than a tab renders, and the choice is between a torn frame and a coordinator
 * whose memory grows without bound. A terminal recovers on the next repaint; the
 * process does not recover from the buffer.
 */
const CONSOLE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Last word of a console socket: the frame that explains the ending. The server
 * does NOT close the socket itself — the browser does, when it sees this frame.
 * That is not politeness: a `Bun.serve` whose websocket was closed BY THE SERVER
 * never resolves its `stop()` again (reproduced on a bare 20-line server, bun
 * 1.2.22), and this connector's stop is on the shutdown path of the whole
 * process. A socket the client forgets to close costs nothing — its attachment
 * is already detached, and `stop(true)` drops the connection.
 */
function endConsole(ws: WsClient, frame: { readonly t: string; readonly message?: string }): void {
  ws.send(JSON.stringify(frame));
}

/**
 * Why a console could not attach, in the operator's own words. Unlike the REST
 * surface (`operatorErrorText`, §3.2) this keeps the real text: the panel that
 * asked is the panel that sees the pane VERBATIM anyway (§12.9), so a tmux
 * message discloses strictly less than the console it failed to open. Capped —
 * an error is a line in a dialog, not a log.
 */
function consoleErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** The console socket's upgrade payload; undefined for the panel's push socket. */
function consoleData(ws: WsClient): ConsoleSocketData | undefined {
  const data = ws.data as Partial<ConsoleSocketData> | undefined;
  return typeof data?.console === "string" && typeof data.owner === "string"
    ? (data as ConsoleSocketData)
    : undefined;
}

/**
 * One panel identity (§17.1): the legacy operator OR a configured user — the
 * generalization the whole surface is written against, so legacy and users mode
 * share ONE code path (a legacy operator is simply a user without `users[]`).
 */
interface Identity {
  readonly name: string;
  readonly title: string | undefined;
  readonly color: string | undefined;
  readonly role: WebchatRole;
  readonly verifier: PasswordVerifier;
  readonly sessions: SessionStore;
  readonly history: HistoryStore | undefined;
  readonly ports: WebchatPorts | undefined;
  readonly lifecycle: WebchatLifecycle | undefined;
  /** A configured user (§17.1) — legacy operators have no self-chat/DND (§16.1). */
  readonly isUser: boolean;
}

/** Live per-peer dynamics of one identity (the WS status-diff source, §12.7). */
interface PeerDynamics {
  status: AgentStatus | "unknown" | undefined;
  paused: boolean;
  depth: number;
  atWipLimit: boolean;
  waiting: boolean;
  awaited: boolean;
  /** Presence of a user peer (§17.5, FR-133); undefined for agents. */
  presence: string | undefined;
  /** Federated peer only (§18.4): link reachability joins the diff. */
  link?: "up" | "down";
}

export class WebchatConnector implements ChannelConnector {
  readonly type = "webchat";
  readonly bindOperator: string | undefined;
  readonly #options: WebchatConnectorOptions;
  /** The mount prefix (T120, §12.2): "" = root, otherwise "/team"-style. */
  readonly #base: string;
  /** Panel identities by name (§17.1): one legacy operator, or the users (FR-127). */
  readonly #identities = new Map<string, Identity>();
  readonly #usersMode: boolean;
  readonly #loginLimiter: LoginRateLimiter;
  readonly #clients = new Set<WsClient>();
  /** Open consoles (§12.9, FR-160) — one live tmux attachment per socket. */
  readonly #consoles = new Map<WsClient, ConsoleSocketState>();
  /** Outgoing ids being watched for queue progress (per identity, in-memory). */
  readonly #tracked = new Map<
    string,
    { owner: string; to: string; phase: MessagePhase | "queued" }
  >();
  /** Keyed "<identity> <peer>" — each identity diffs its OWN peers (§10.22). */
  readonly #dynamics = new Map<string, PeerDynamics>();
  /** Upload-time blob metadata; history is the durable fallback (§12.5). */
  readonly #blobMeta = new Map<string, { name: string; mime: string; size: number }>();
  #server: ReturnType<typeof Bun.serve> | undefined;
  #onInbound: InboundHandler | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #unsubscribeTransport: (() => void) | undefined;

  constructor(options: WebchatConnectorOptions) {
    this.bindOperator = options.bindOperator;
    this.#options = options;
    this.#base = options.basePath ?? "";
    this.#usersMode = (options.users?.length ?? 0) > 0;
    const sessionSeams = {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.newToken !== undefined ? { newToken: options.newToken } : {}),
    };
    if (this.#usersMode) {
      // Users mode (§17.2): every user gets their OWN session store, history and
      // ports — the isolation of §10.22 is the object graph, not a check.
      for (const user of options.users ?? []) {
        this.#identities.set(user.name, {
          name: user.name,
          title: user.title,
          color: user.color,
          role: user.role,
          verifier: {
            ...(user.password !== undefined ? { password: user.password } : {}),
            ...(user.passwordHash !== undefined ? { passwordHash: user.passwordHash } : {}),
          },
          sessions: new SessionStore({ ...user.session, ...sessionSeams }),
          history: user.history,
          ports: user.ports,
          lifecycle: user.lifecycle,
          isUser: true,
        });
      }
    } else if (options.bindOperator !== undefined) {
      // Legacy (§12.1): ONE identity built from the channel-wide options. It is an
      // `admin` — the pre-§17 panel showed the transport journal to whoever logged
      // in (§17.7 replaces that rule with roles only for users mode).
      this.#identities.set(options.bindOperator, {
        name: options.bindOperator,
        title: undefined,
        color: undefined,
        role: "admin",
        verifier: options.password !== undefined ? { password: options.password } : {},
        sessions: new SessionStore({ ...options.session, ...sessionSeams }),
        history: options.history,
        ports: options.ports,
        lifecycle: options.lifecycle,
        isUser: false,
      });
    }
    this.#loginLimiter = new LoginRateLimiter(options.loginRate ?? {});
    // The hub notifies humans through the panel (§19.6), so it needs a way back in.
    // Registering HERE keeps the wiring one-directional at assembly: the server
    // builds the hub (which the MCP `react` tool also uses) without knowing about
    // sockets, and the connector supplies the only socket-aware part.
    options.reactions?.registerPush((owner, event) => {
      this.#push(
        {
          type: "reaction",
          peer: event.peer,
          messageId: event.messageId,
          reactions: event.reactions,
        },
        owner,
      );
    });
    // The journal's own push (§19.13, FR-182): an agent↔agent pair has no owner
    // with tabs, so the badge goes to whoever is watching the journal — role-gated
    // exactly like the transport feed itself (§17.7, FR-131).
    options.reactions?.registerJournalPush((event) => {
      for (const identity of this.#identities.values()) {
        if (identity.role !== "admin") continue;
        this.#push(
          {
            type: "transport-reaction",
            messageId: event.messageId,
            reactions: event.reactions,
          },
          identity.name,
        );
      }
    });
  }

  /** Identity of the session cookie, or undefined when unauthenticated (§10.12). */
  #identify(req: Request): Identity | undefined {
    const token = sessionToken(req);
    if (token === "") return undefined;
    for (const identity of this.#identities.values()) {
      if (identity.sessions.has(token)) return identity;
    }
    return undefined;
  }

  /** The bound listener port (after start). */
  get port(): number {
    return this.#server?.port ?? this.#options.port;
  }

  /** The durable chat log (§12.3) — bootstrap wires it into the retention sweep. */
  get history(): HistoryStore | undefined {
    return this.#options.history;
  }

  /** Every log this panel serves (§12.3/§17.7) — legacy: one; users mode: per user. */
  get histories(): readonly HistoryStore[] {
    const stores = [...this.#identities.values()].flatMap((identity) =>
      identity.history !== undefined ? [identity.history] : [],
    );
    return stores.length > 0 ? stores : [];
  }

  async start(onInbound: InboundHandler): Promise<void> {
    if (this.#server !== undefined) throw new Error("webchat connector already started");
    this.#onInbound = onInbound;
    this.#server = Bun.serve({
      port: this.#options.port,
      hostname: this.#options.bind ?? "127.0.0.1",
      fetch: (req, server) => {
        const path = new URL(req.url).pathname;
        // WS upgrade — behind the same auth gate (§10.12) and only here: the
        // socket is push-only, all input stays on the audited REST surface. The
        // socket is TAGGED with its identity so pushes reach that user's tabs
        // only (§10.22).
        if (path === `${this.#base}/api/ws`) {
          const identity = this.#identify(req);
          if (identity === undefined) return json({ error: "authentication required" }, 401);
          if (server.upgrade(req, { data: { owner: identity.name } })) return undefined;
          return json({ error: "websocket upgrade required" }, 400);
        }
        // The console socket (§12.9, FR-160) is the ONE socket that carries input:
        // it is a terminal, not the panel's control channel. Its gates are the
        // gates of every other console action — auth (§10.12) and the structural
        // neighbour edge (§10.2) — and both are checked BEFORE the upgrade, so an
        // unauthorized attach never reaches a pane.
        const agent = this.#consoleTarget(path);
        if (agent !== undefined) {
          const identity = this.#identify(req);
          if (identity === undefined) return json({ error: "authentication required" }, 401);
          if (identity.lifecycle?.console === undefined) {
            return json({ error: "console is not wired" }, 503);
          }
          if (!(identity.ports?.listPeers() ?? []).includes(agent)) {
            return json({ error: `unknown agent "${agent}"` }, 404); // not a neighbour
          }
          const data: ConsoleSocketData = { owner: identity.name, console: agent };
          if (server.upgrade(req, { data })) return undefined;
          return json({ error: "websocket upgrade required" }, 400);
        }
        return this.handleRequest(req, server.requestIP(req)?.address);
      },
      websocket: {
        open: (ws) => {
          if (consoleData(ws) !== undefined) {
            this.#consoles.set(ws, {
              attachment: undefined,
              closed: false,
              pending: [],
              line: new ConsoleLineBuffer(),
            });
            void this.#openConsole(ws);
            return;
          }
          this.#clients.add(ws);
        },
        close: (ws) => {
          this.#clients.delete(ws);
          const state = this.#consoles.get(ws);
          if (state === undefined) return;
          state.closed = true;
          state.attachment?.close(); // closing the popup detaches, always (§12.9)
          this.#consoles.delete(ws);
        },
        message: (ws, message) => {
          // Panel socket: input goes through REST only (§12.4). Console socket:
          // binary frames ARE the keystrokes, forwarded verbatim (§12.9).
          const state = this.#consoles.get(ws);
          if (state === undefined || typeof message === "string") return;
          const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
          if (bytes.length === 0 || bytes.length > CONSOLE_INPUT_MAX_BYTES) return;
          if (state.attachment === undefined) state.pending.push(new Uint8Array(bytes));
          else state.attachment.write(bytes);
          // The keystrokes also become chat history (§12.9.6, FR-170): the delivery
          // already happened through the pane, so this is a RECORD of what was said,
          // written without routing — no queue, no journal, no reply window.
          this.#recordConsoleInput(ws, state, bytes);
        },
      },
    });
    if ([...this.#identities.values()].some((identity) => identity.ports !== undefined)) {
      const pollMs = this.#options.pollMs ?? 500;
      this.#pollTimer = setInterval(() => void this.#pollOnce(), pollMs);
    }
    // Live transport feed (FR-48): every freshly routed record reaches the
    // connected tabs; the page endpoint serves history and reconnect catch-up.
    // Role-gated like the endpoint (§17.7, FR-131) — only admins' tabs get it.
    this.#unsubscribeTransport = this.#options.transport?.subscribe((record) => {
      for (const identity of this.#identities.values()) {
        if (identity.role === "admin") this.#push({ type: "transport", record }, identity.name);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = undefined;
    // Every open console is a live tmux client (§12.9) — a stopped connector
    // must not leave one attached to an agent's pane.
    for (const state of this.#consoles.values()) {
      state.closed = true;
      state.attachment?.close();
    }
    this.#consoles.clear();
    await this.#server?.stop(true);
    this.#server = undefined;
    this.#clients.clear();
  }

  /**
   * Egress sink (§8.4): the history append IS the delivery (§12.3) — a duplicate
   * id is a no-op success (§10.9), no browser needs to be connected. Throw (no
   * history / fs error) = the record stays queued for re-send (§10.9).
   *
   * Legacy mode only. In users mode the sink is the USER's pseudo-session egress
   * (§17.5): it writes the history itself and then fans the push out over every
   * bound channel — this connector is one of those push targets ({@link pushTo}).
   */
  async deliver(signal: Signal): Promise<void> {
    const history = this.#options.history;
    if (history === undefined) {
      throw new Error("webchat history is not wired — outbound delivery is queued");
    }
    const fresh = await history.append(signal);
    if (fresh) {
      this.#push({ type: "message", record: signal }, this.bindOperator);
      this.#options.onDelivered?.(signal);
    }
  }

  /**
   * Users-mode push (§17.5, FR-124): notify one user's connected tabs about a
   * record their pseudo-session egress has ALREADY written to their history. Pure
   * best-effort — nothing is lost when no tab is open, the panel reads the tail on
   * reconnect (§12.3). Unknown user (not bound to this channel) ⇒ a no-op.
   */
  pushTo(user: string, signal: Signal): void {
    if (!this.#identities.has(user)) return;
    this.#push({ type: "message", record: signal }, user);
    this.#options.onDelivered?.(signal);
  }

  /**
   * The panel surface (exposed for in-process tests, like the admin plane).
   * Order is the §10.12 guard: CSRF gate → auth gate → route dispatch; core
   * ports are reachable only past the gates.
   */
  async handleRequest(req: Request, clientIp?: string): Promise<Response> {
    const url = new URL(req.url);
    // The basePath mount (T120, §12.2): the surface exists ONLY under the
    // prefix. "<prefix>" itself redirects to "<prefix>/" — the SPA is built on
    // relative URLs (§12.6), which resolve correctly only from the slashed
    // form. Everything outside the prefix is a plain 404; past this point the
    // prefix is stripped and the routing below stays prefix-blind.
    if (this.#base !== "") {
      if (url.pathname === this.#base) {
        return new Response(null, { status: 308, headers: { location: `${this.#base}/` } });
      }
      if (!url.pathname.startsWith(`${this.#base}/`)) return json({ error: "not found" }, 404);
      url.pathname = url.pathname.slice(this.#base.length);
    }
    if (!url.pathname.startsWith("/api/")) {
      // The SPA statics (§12.7). Unauthenticated by design — the app shell is
      // public, every API behind it is gated (§10.12); GET-only, path-safe.
      if (req.method === "GET" || req.method === "HEAD") return this.serveStatic(url.pathname, req);
      return json({ error: "not found" }, 404);
    }
    // CSRF (§12.6): a browser request that CHANGES something carries Origin; a
    // mismatched one is rejected for every endpoint, login included. Every
    // mutating verb is covered, not POST alone — the prompt library (§20.3) edits
    // with PATCH and DELETE, and a gate that only knows one verb is not a gate.
    if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req)) {
      return json({ error: "cross-origin request rejected" }, 403);
    }
    if (url.pathname === "/api/login") return this.handleLogin(req, clientIp);
    // Auth gate (§10.12): everything else requires a live session — checked
    // before any body parse or route handling. The resolved identity (§17.1) is
    // threaded into every handler, so a request can only ever touch its own
    // user's history/peers/blobs (§10.22).
    const me = this.#identify(req);
    if (me === undefined) return json({ error: "authentication required" }, 401);
    if (url.pathname === "/api/logout" && req.method === "POST") return this.handleLogout(req, me);
    if (url.pathname === "/api/session" && req.method === "GET") return this.handleSession(req, me);
    if (url.pathname === "/api/session/renew" && req.method === "POST") {
      return this.handleSessionRenew(req, me);
    }
    if (url.pathname === "/api/send" && req.method === "POST") return this.handleSend(req, me);
    if (url.pathname === "/api/peers" && req.method === "GET") return this.handlePeers(me);
    if (url.pathname === "/api/server" && req.method === "GET") return this.handleServerInfo();
    // history export/clear (FR-84): /api/history/<peer>/(export|clear) — matched
    // by SEGMENTS so a peer literally named "export" still pages normally.
    // Reactions (§19.5, FR-161/FR-162): the catalog, then place/remove on one
    // message. Matched BEFORE the paging route below — both live under
    // /api/history/, and the deeper shape is the more specific one.
    if (url.pathname === "/api/reactions" && req.method === "GET") {
      return this.handleReactionCatalog();
    }
    // Prompt library (§20.3, FR-184): the rack of the SIGNED-IN user — the owner
    // comes from `me`, never from the path, so a foreign rack has no address.
    if (url.pathname === "/api/prompts" && req.method === "GET") {
      return this.handlePromptLibrary(me);
    }
    const promptTarget = promptRoute(url.pathname);
    if (promptTarget !== null) return this.handlePrompts(promptTarget, req, me);
    const reaction = reactionRoute(url.pathname);
    if (reaction !== null && (req.method === "POST" || req.method === "DELETE")) {
      return this.handleReaction(reaction, req, me);
    }
    const historySub = historySubRoute(url.pathname);
    if (historySub?.action === "export" && req.method === "GET") {
      return this.handleExport(historySub.peer, me);
    }
    if (historySub?.action === "clear" && req.method === "POST") {
      return this.handleClear(historySub.peer, me);
    }
    if (url.pathname.startsWith("/api/history/") && req.method === "GET") {
      return this.handleHistory(url, me);
    }
    if (url.pathname === "/api/read" && req.method === "POST") return this.handleRead(req, me);
    // GET /api/agents/:name/tokens (§12.8, FR-103): the token-usage series the
    // panel widgets poll; matched by suffix before the screen catch-all.
    if (
      url.pathname.startsWith("/api/agents/") &&
      url.pathname.endsWith("/tokens") &&
      req.method === "GET"
    ) {
      return this.handleAgentTokens(url, me);
    }
    // GET /api/agents/:name/screen (FR-102): a live console snapshot the panel
    // polls; matched before the POST-action route below.
    if (url.pathname.startsWith("/api/agents/") && req.method === "GET") {
      return this.handleAgentScreen(url, me);
    }
    // POST /api/agents/command (§15.8, FR-115): slash-command to a selector
    // INTERSECTION — matched before the single-agent /api/agents/:name/... route.
    if (url.pathname === "/api/agents/command" && req.method === "POST") {
      return this.handleCommandFanout(req, me);
    }
    if (url.pathname.startsWith("/api/agents/") && req.method === "POST") {
      return this.handleAgentAction(url, req, me);
    }
    if (url.pathname === "/api/transport" && req.method === "GET") {
      return this.handleTransport(url, me);
    }
    if (url.pathname === "/api/blobs" && req.method === "POST") return this.handleUpload(req);
    if (url.pathname.startsWith("/api/blobs/") && req.method === "GET") {
      return this.handleDownload(url, me);
    }
    return json({ error: "not found" }, 404);
  }

  // POST /api/login {user?, password} (§12.6, §17.4): `user` is required in users
  // mode and ignored in legacy. The rate limit is keyed by (user, IP) — FR-122 —
  // so one account being hammered cannot lock the others out.
  async handleLogin(req: Request, clientIp?: string): Promise<Response> {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const body = await readJsonObject(req);
    const password = body?.password;
    const name = typeof body?.user === "string" ? body.user : undefined;
    if (!this.#loginLimiter.allow(`${name ?? ""}\u0000${clientIp ?? "global"}`)) {
      return json({ error: "too many login attempts — try again later" }, 429);
    }
    if (this.#usersMode && name === undefined) {
      return json({ error: '"user" is required' }, 400);
    }
    const identity =
      name !== undefined
        ? this.#identities.get(name)
        : this.#identities.get(this.bindOperator ?? "");
    // An unknown user and a wrong password are the SAME answer (§8.7): the login
    // form must not enumerate accounts.
    if (
      identity === undefined ||
      typeof password !== "string" ||
      !(await verifyPassword(password, identity.verifier))
    ) {
      return json({ error: "invalid credentials" }, 401);
    }
    const token = identity.sessions.issue();
    // Max-Age mirrors the server-side TTL (§12.6, FR-57): the cookie outlives
    // the browser session and dies together with the stored token. The payload
    // carries expiresAt (FR-86) — the panel schedules its auto-renewal from it.
    return new Response(
      JSON.stringify({
        ok: true,
        user: identity.name,
        role: identity.role,
        expiresAt: identity.sessions.expiresAt(token),
      }),
      {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          "set-cookie": this.#sessionCookie(req, token, identity.sessions.ttlMs),
        },
      },
    );
  }

  // GET /api/session (T125, FR-86): when does this session die — the page-reload
  // path: the cookie survives the reload, the in-memory expiry knowledge does not.
  // Carries the identity too (§17.7): the panel needs to know WHO it is logged in
  // as and whether the transport journal is available to that role (FR-131).
  async handleSession(req: Request, me: Identity): Promise<Response> {
    return json({
      expiresAt: me.sessions.expiresAt(sessionToken(req)),
      user: me.name,
      role: me.role,
      ...(me.title !== undefined ? { title: me.title } : {}),
      ...(me.isUser ? { selfChat: true } : {}),
    });
  }

  // POST /api/session/renew (T125, FR-86): slide the SAME token's expiry by the
  // configured renewal window and re-issue the cookie with a matching Max-Age.
  // Behind the auth gate — an expired session cannot renew itself (re-login).
  async handleSessionRenew(req: Request, me: Identity): Promise<Response> {
    const token = sessionToken(req);
    const expiresAt = me.sessions.renew(token);
    if (expiresAt === undefined) return json({ error: "authentication required" }, 401);
    return new Response(JSON.stringify({ ok: true, expiresAt }), {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        "set-cookie": this.#sessionCookie(req, token, me.sessions.renewMs),
      },
    });
  }

  /**
   * The session cookie line: Secure only behind TLS (the reverse-proxy reports
   * it, §12.6) — a plain localhost session must still carry the cookie; Path
   * scopes it to the basePath mount (T120) — panels under one host don't share
   * sessions, at the root it stays "/" exactly as before.
   */
  #sessionCookie(req: Request, token: string, lifeMs: number): string {
    const secure = req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
    const maxAge = Math.floor(lifeMs / 1000);
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=${this.#cookiePath()}; Max-Age=${maxAge}${secure}`;
  }

  // POST /api/logout (FR-68): revoke the session SERVER-SIDE (the durable store
  // included — a stolen cookie dies with it) and expire the cookie. Behind the
  // auth gate like everything else: only a live session can end itself.
  async handleLogout(req: Request, me: Identity): Promise<Response> {
    me.sessions.revoke(sessionToken(req));
    const secure = req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=${this.#cookiePath()}; Max-Age=0${secure}`,
      },
    });
  }

  /** The session cookie's Path: the basePath mount, "/" at the root (T120). */
  #cookiePath(): string {
    return this.#base === "" ? "/" : this.#base;
  }

  // POST /api/send {to, text?, blobs?, id, raw?, replyTo?} → Message → router
  // (§12.4/§12.5). `replyTo` (FR-178) names an EARLIER message of this user's
  // history — the envelope carries the reference, the payload stays what was typed.
  // The id is client-generated — the idempotency key for retries (§10.9). Media
  // travels as OPAQUE blob ids uploaded beforehand (§5.3); the payload carries
  // refs with their upload-time name/mime/size. Raw mode (FR-88, §14.3): `raw`
  // sends the text to the terminal as-is — media is disabled, so blobs are
  // rejected and text is required.
  async handleSend(req: Request, me: Identity): Promise<Response> {
    const body = await readJsonObject(req);
    if (body === undefined) return json({ error: "body must be a JSON object" }, 400);
    const { to, text, id } = body;
    if (typeof to !== "string" || to.length === 0) {
      return json({ error: '"to" (non-empty string) is required' }, 400);
    }
    if (typeof id !== "string" || id.length === 0) {
      return json({ error: '"id" (non-empty string, client-generated) is required (§10.9)' }, 400);
    }
    const raw = body.raw === true;
    // A group/tag is a one-directional broadcast target (§15.6): raw mode injects
    // verbatim into ONE console, so it is meaningless for a fan-out — reject it.
    const targetKind = me.ports?.peerType?.(to) ?? "agent";
    if (raw && targetKind !== "agent") {
      return json({ error: "raw mode does not target a group/tag (§15.6)" }, 400);
    }
    // Reply to an earlier message (FR-178, §12.7): the id travels in the envelope
    // (§5.3 `replyTo`), so the agent is TOLD what this answers and can read it by
    // id (FR-179) — no quote is pasted into the payload.
    const replyTo = body.replyTo;
    if (replyTo !== undefined && (typeof replyTo !== "string" || replyTo.length === 0)) {
      return json({ error: '"replyTo" must be a non-empty message id' }, 400);
    }
    // Raw mode (§14.3) types the text into a console — there is no envelope on the
    // other end to carry a reference, so a reply there would be a silent lie.
    if (raw && typeof replyTo === "string") {
      return json({ error: "raw mode does not carry a reply reference (§14.3)" }, 400);
    }
    // The quoted message must EXIST in this user's history: an id pointing at
    // nothing reaches the agent as a promise of context it cannot fetch.
    if (typeof replyTo === "string" && me.history !== undefined) {
      if ((await me.history.find(replyTo, to)) === undefined) {
        return json({ error: `unknown message "${replyTo}" — nothing to reply to` }, 422);
      }
    }
    const blobIds = Array.isArray(body.blobs) ? body.blobs : [];
    const hasText = typeof text === "string" && text.length > 0;
    if (raw && blobIds.length > 0) {
      return json({ error: "raw mode does not support attachments (§14.3)" }, 400);
    }
    if (raw && !hasText) {
      return json({ error: '"text" is required in raw mode (§14.3)' }, 400);
    }
    if (!hasText && blobIds.length === 0) {
      return json({ error: '"text" and/or "blobs" is required' }, 400);
    }
    const refs: BlobRef[] = [];
    for (const blobId of blobIds) {
      if (typeof blobId !== "string" || blobId.length === 0) {
        return json({ error: '"blobs" must be an array of blob ids' }, 400);
      }
      const meta = this.#blobMeta.get(blobId) ?? (await me.history?.findBlobRef(blobId));
      if (meta === undefined) {
        return json({ error: `unknown blob "${blobId}" — upload it first (§12.5)` }, 422);
      }
      refs.push({ blob: blobId, ...meta, ...this.#blobMeta.get(blobId) });
    }
    const message: Message = {
      id,
      from: me.name,
      to,
      kind: "message",
      ts: (this.#options.now ?? Date.now)(),
      // Plain text stays a string (the baseline shape); media uses the §5.3
      // {text?, blobs} convention with opaque refs.
      payload: refs.length === 0 ? (text as string) : { ...(hasText ? { text } : {}), blobs: refs },
      ...(typeof replyTo === "string" ? { replyTo } : {}),
      origin: "webchat",
      // Raw transport mode (FR-88, §14): the dispatcher injects the text verbatim
      // and captures the console as the reply.
      ...(raw ? { raw: true } : {}),
    };
    const onInbound = this.#onInbound;
    if (onInbound === undefined) return json({ error: "connector not started" }, 503);
    try {
      await onInbound(message);
    } catch (error) {
      return json({ error: operatorErrorText(error) }, 422); // §3.2, redacted (§8.7)
    }
    // The queue record is the source of truth; the history line is the panel's
    // view (§12.3). A failed append must not surface as a send failure — the
    // client would retry and enqueue a duplicate. A note to SELF (§17.7) is
    // deliberately not appended here: it comes back through the sender's own
    // pseudo-session egress, which writes it once (§17.5 — one sink).
    if (message.to !== me.name) {
      await me.history?.append(message).catch(() => undefined);
    }
    // Watch the recipient's queue for this id (§12.7 lifecycle) and let every
    // connected tab see the outbound + the ack. A group/tag has no queue of its own
    // (§15.1) — the fan-out lands in each member's queue — so there is no single
    // phase to track; skip tracking, still echo the outgoing broadcast.
    if (targetKind === "agent" && message.to !== me.name) {
      this.#tracked.set(message.id, { owner: me.name, to: message.to, phase: "queued" });
    }
    this.#push({ type: "ack", id: message.id, to: message.to }, me.name);
    if (message.to !== me.name) this.#push({ type: "message", record: message }, me.name);
    return json({ queued: true, id: message.id, to: message.to });
  }

  // GET /api/peers (§12.4): the operator's agent neighbors (§10.2) with live
  // status, queue depth, unread badge, a last-message preview and the available
  // lifecycle actions (FR-65 — drives the panel's Shutdown/Reload buttons).
  // `operator` = the bound operator's name — the sidebar's account button (FR-68).
  // Self-chat (§17.7, FR-128) rides in the SAME array: the user's own name joins
  // their neighbors (self-delivery needs no edge, §10.2) and is built by the same
  // code path, so the sidebar row is a user row like any other — same presence
  // dot, preview, unread badge and group placement. A legacy operator (§17.9) has
  // no user identity and therefore no self entry.
  async handlePeers(me: Identity): Promise<Response> {
    const ports = me.ports;
    const history = me.history;
    const lifecycle = me.lifecycle;
    const neighbors = ports?.listPeers() ?? [];
    const names = me.isUser ? [...neighbors, me.name].sort() : neighbors;
    const rz = ports?.rendezvousState?.() ?? { waiting: [], awaited: [] };
    const peers = await Promise.all(
      names.map(async (name) => {
        // The self row previews the AGGREGATE (§17.7, FR-128): its thread is the
        // projection of every pair, so the preview must be the newest record of
        // all — not the newest note-to-self, which would look stale beside it.
        const isSelf = me.isUser && name === me.name;
        const last = isSelf ? await history?.newest() : await history?.last(name);
        const color = ports?.peerColor?.(name);
        // A user peer (§17.7, FR-129) has no session: no queue depth, no console,
        // no lifecycle — a presence dot instead of a status dot (FR-133). The
        // viewer's own row is a user row too (self-chat, FR-128).
        const kind = ports?.peerType?.(name) ?? "agent";
        const isUserPeer = kind === "user" || isSelf;
        const depth = isUserPeer ? 0 : ((await ports?.queueDepth(name).catch(() => 0)) ?? 0);
        const marks =
          ports === undefined || isUserPeer ? undefined : this.#peerMarks(name, depth, rz, ports);
        // Group/tag membership (§15, FR-112) — the sidebar builds the tree from these.
        const group = ports?.agentGroup?.(name);
        const tags = ports?.agentTags?.(name) ?? [];
        const presence = isUserPeer ? ports?.peerPresence?.(name) : undefined;
        return {
          name,
          type: isUserPeer ? ("user" as const) : ("agent" as const),
          status: isUserPeer ? null : (ports?.peerStatus(name) ?? null),
          // §16.6 (FR-119): a marker BESIDE the status, not a fourth status value.
          // For a user this is DND (§17.8, FR-134) — the same marker, weaker rights.
          paused: ports?.peerPaused?.(name) ?? false,
          queueDepth: depth,
          unread: (await history?.unread(name)) ?? 0,
          ...(presence !== undefined ? { presence } : {}),
          ...(ports?.peerTitle?.(name) !== undefined ? { title: ports.peerTitle(name) } : {}),
          ...(group !== undefined ? { group } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(marks !== undefined
            ? { atWipLimit: marks.atWipLimit, waiting: marks.waiting, awaited: marks.awaited }
            : {}),
          ...(color !== undefined ? { color } : {}),
          ...(lifecycle !== undefined
            ? { actions: lifecycle.actions(name), commands: lifecycle.commands(name) }
            : {}),
          ...(last !== undefined
            ? { lastMessage: { ts: last.ts, from: last.from, preview: preview(last.payload) } }
            : {}),
        };
      }),
    );
    // Group/tag broadcast peers (§15.6, FR-112): input-only — a `type` and members,
    // but no status/queue/unread/actions. They ride in the same peers array; the
    // sidebar renders the group tree and the Tags section from `type`.
    const broadcast = ports?.broadcastPeers?.() ?? [];
    // Federated peers (§18.4, FR-144/FR-150): read-only rows — the projection plus
    // `server`/`link`, an ordinary 1:1 chat with history/unread, and NO console
    // affordances: actions all false, commands empty — the panel's chrome follows.
    const remote = await Promise.all(
      (ports?.remotePeers?.() ?? []).map(async (peer) => {
        const last = await history?.last(peer.name);
        return {
          name: peer.name,
          type: peer.type,
          server: peer.server,
          link: peer.link,
          status: peer.status ?? null,
          ...(peer.presence !== undefined ? { presence: peer.presence } : {}),
          paused: peer.paused,
          ...(peer.reason !== undefined ? { reason: peer.reason } : {}),
          queueDepth: 0,
          unread: (await history?.unread(peer.name)) ?? 0,
          actions: { shutdown: false, reload: false, pause: false },
          commands: [],
          ...(last !== undefined
            ? { lastMessage: { ts: last.ts, from: last.from, preview: preview(last.payload) } }
            : {}),
        };
      }),
    );
    return json({
      peers: [...peers, ...broadcast, ...remote],
      // `operator` stays for compatibility with the pre-§17 panel; `user`/`role`
      // are the users-mode identity (FR-127/FR-131). `user` also names the row
      // that is the self-chat — the panel needs no separate self object.
      operator: me.name,
      user: me.name,
      role: me.role,
    });
  }

  // GET /api/server (FR-91, §12.4): the server's build info for the Settings footer
  // — version + the deployed commit and its date. Behind the auth gate (§10.12);
  // absent ⇒ 503 (the panel then shows no footer).
  async handleServerInfo(): Promise<Response> {
    const info = this.#options.serverInfo;
    if (info === undefined) return json({ error: "server info not wired" }, 503);
    return json(info);
  }

  // POST /api/agents/:name/(shutdown|reload|command|pause) (T85/T86, FR-65/FR-66,
  // §16.5/FR-119):
  // the §10.12 capability extension — graceful lifecycle + configured slash
  // commands of the operator's TOPOLOGY NEIGHBORS only; the peer check is
  // structural (the same listPeers the panel sees), so the panel can never
  // reach an agent its operator is not wired to (§10.2).
  async handleAgentAction(url: URL, req: Request, me: Identity): Promise<Response> {
    const lifecycle = me.lifecycle;
    if (lifecycle === undefined) return json({ error: "lifecycle port not wired" }, 503);
    const rest = url.pathname.slice("/api/agents/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return json({ error: "not found" }, 404);
    const name = decodeURIComponent(rest.slice(0, slash));
    const action = rest.slice(slash + 1);
    if (
      action !== "shutdown" &&
      action !== "reload" &&
      action !== "command" &&
      action !== "pause"
    ) {
      return json({ error: "not found" }, 404);
    }
    const peers = me.ports?.listPeers() ?? [];
    // DND (§17.8, FR-134): the pause of a USER is settable by that user themselves
    // (the self-chat switch) and by any `role:"admin"` user — for anything else the
    // §10.2 neighbour gate below decides.
    // DND (§17.8, FR-134) has its OWN rule, narrower than the neighbour gate: a
    // user's pause may be set by that user alone or by a `role:"admin"` user.
    // Being topology neighbours is NOT enough — otherwise any user could silence
    // any other one they happen to be wired to.
    const targetIsUser = name === me.name ? me.isUser : me.ports?.peerType?.(name) === "user";
    if (targetIsUser) {
      if (action !== "pause") return json({ error: `unknown agent "${name}"` }, 404);
      const mayPause = name === me.name ? me.isUser : me.role === "admin";
      if (!mayPause) {
        return json({ error: "only the user themselves or an admin may set DND (§17.8)" }, 403);
      }
    } else if (!peers.includes(name)) {
      return json({ error: `unknown agent "${name}"` }, 404); // not a neighbor (§10.2)
    }
    try {
      // Pause / resume (§16.5, FR-119): the same neighbour gate as the lifecycle
      // twins, but a weaker capability — reversible, and it never touches the
      // session. The body carries the DESIRED state, so a stale tab cannot flip it.
      if (action === "pause") {
        const pause = lifecycle.pause;
        if (pause === undefined) return json({ error: "pause is not wired" }, 503);
        const body = await readJsonObject(req);
        const paused = body?.paused;
        if (typeof paused !== "boolean") {
          return json({ error: '"paused" (boolean) is required' }, 400);
        }
        return json({ ok: true, paused: await pause(name, paused) });
      }
      if (action === "command") {
        const body = await readJsonObject(req);
        const commandSlash = body?.slash;
        if (typeof commandSlash !== "string" || commandSlash.length === 0) {
          return json({ error: '"slash" (non-empty string) is required' }, 400);
        }
        // the configured list IS the allowlist (FR-66) — the port refuses the rest
        return json({ ok: true, output: await lifecycle.runCommand(name, commandSlash) });
      }
      const status =
        action === "shutdown" ? await lifecycle.shutdown(name) : await lifecycle.reload(name);
      return json({ ok: true, status });
    } catch (error) {
      return json({ error: operatorErrorText(error) }, 409); // §3.2, redacted (§8.7)
    }
  }

  // POST /api/agents/command (§15.8, FR-115): one slash-command to the INTERSECTION
  // of a set of selectors (groups/tags/agents). The neighbour gate (§10.2) is
  // applied PER-AGENT inside the wired fanout — a non-neighbour agent in the
  // intersection comes back COMMAND_DENIED rather than being reached.
  async handleCommandFanout(req: Request, me: Identity): Promise<Response> {
    const fanout = me.lifecycle?.commandFanout;
    if (fanout === undefined) return json({ error: "command-fanout not wired" }, 503);
    const body = await readJsonObject(req);
    const slash = body?.slash;
    const selectors = body?.selectors;
    if (typeof slash !== "string" || slash.length === 0) {
      return json({ error: '"slash" (non-empty string) is required' }, 400);
    }
    if (
      !Array.isArray(selectors) ||
      selectors.length === 0 ||
      !selectors.every((s) => typeof s === "string" && s.length > 0)
    ) {
      return json({ error: '"selectors" (non-empty string[]) is required' }, 400);
    }
    const result = await fanout(slash, selectors);
    return json(result, result.ok ? 200 : 400); // ok:false ⇒ INVALID_ARGS/UNKNOWN_SELECTOR
  }

  // GET /api/agents/:name/screen (FR-102): the peer's VISIBLE console pane as-is
  // — the read-only TEXT capture (what `get_screen` hands an agent, FR-147); the
  // panel's own console is the socket below (§12.9). Same structural neighbor gate
  // as the POST actions (§10.2): the panel can only watch an agent it is wired to.
  async handleAgentScreen(url: URL, me: Identity): Promise<Response> {
    const lifecycle = me.lifecycle;
    if (lifecycle?.screen === undefined) return json({ error: "screen capture not wired" }, 503);
    const rest = url.pathname.slice("/api/agents/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || rest.slice(slash + 1) !== "screen") return json({ error: "not found" }, 404);
    const name = decodeURIComponent(rest.slice(0, slash));
    const peers = me.ports?.listPeers() ?? [];
    if (!peers.includes(name)) {
      return json({ error: `unknown agent "${name}"` }, 404); // not a neighbor (§10.2)
    }
    try {
      return json({ ok: true, output: await lifecycle.screen(name) });
    } catch (error) {
      return json({ error: operatorErrorText(error) }, 409); // §3.2, redacted (§8.7)
    }
  }

  /** `<base>/api/agents/<name>/console` → the agent name (§12.4, §12.9, FR-160). */
  #consoleTarget(path: string): string | undefined {
    const prefix = `${this.#base}/api/agents/`;
    const suffix = "/console";
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return undefined;
    const name = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    return name.length > 0 && !name.includes("/") ? name : undefined;
  }

  /**
   * Attaches an upgraded console socket to its pane (§12.9, FR-160). The gates
   * already ran at the upgrade; what can still fail here is the pane itself — a
   * dead session, an agent that never had one — and that comes back as an error
   * frame plus a close, never as a socket that silently shows nothing.
   */
  async #openConsole(ws: WsClient): Promise<void> {
    const data = consoleData(ws);
    const state = this.#consoles.get(ws);
    if (data === undefined || state === undefined) return;
    const lifecycle = this.#identities.get(data.owner)?.lifecycle;
    if (lifecycle?.console === undefined) {
      this.#failConsole(ws, "console is not wired");
      return;
    }
    // Output produced between the attach and the `init` frame waits for it: the
    // browser must size its emulator before the first byte lands in it.
    let live = false;
    const backlog: Uint8Array[] = [];
    try {
      const attachment = await lifecycle.console(data.console, {
        onData: (bytes) => {
          if (state.closed) return;
          if (!live) {
            backlog.push(new Uint8Array(bytes));
            return;
          }
          if ((ws.getBufferedAmount?.() ?? 0) > CONSOLE_MAX_BUFFERED_BYTES) return; // see the cap
          ws.send(bytes);
        },
        onExit: () => {
          if (state.closed) return;
          state.closed = true;
          endConsole(ws, { t: "exit" }); // the pane is gone — the popup says so
        },
      });
      if (state.closed) {
        attachment.close(); // the tab was closed while the attach was in flight
        return;
      }
      state.attachment = attachment;
      ws.send(
        JSON.stringify({
          t: "init",
          cols: attachment.cols,
          rows: attachment.rows,
          screen: attachment.screen,
        }),
      );
      live = true;
      for (const chunk of backlog) ws.send(chunk);
      backlog.length = 0;
      for (const chunk of state.pending) attachment.write(chunk);
      state.pending = [];
    } catch (error) {
      this.#failConsole(ws, consoleErrorText(error));
    }
  }

  /**
   * Console input → chat history (§12.9.6, FR-170). One record per submitted line,
   * `origin:"console"`, appended to the pair's log and pushed to the owner's tabs —
   * and pointedly NOT routed: the agent already got the keystrokes, so routing would
   * inject the same text twice. That is why there is no queue phase, no transport
   * journal line, no reply window and no receipt: the history here is a log of what
   * happened, not a delivery sink.
   */
  #recordConsoleInput(ws: WsClient, state: ConsoleSocketState, bytes: Uint8Array): void {
    const data = consoleData(ws);
    if (data === undefined) return;
    const identity = this.#identities.get(data.owner);
    const history = identity?.history;
    const { submitted, discarded } = state.line.feed(bytes);
    if (discarded > 0) {
      // Never silent (the T239 rule): a line edited with arrows/Ctrl-C is dropped
      // rather than recorded wrongly, and the operator can see that it happened.
      warn(
        `console input of "${data.owner}" → "${data.console}" was not recorded: ` +
          `${discarded} line(s) became unreconstructable (§12.9.6)`,
      );
    }
    if (history === undefined || submitted.length === 0) return;
    for (const text of submitted) {
      const record: Signal = {
        id: randomUUID(),
        from: data.owner,
        to: data.console,
        kind: "message",
        ts: (this.#options.now ?? Date.now)(),
        payload: text,
        origin: "console",
      };
      void history
        .append(record)
        .then((fresh) => {
          if (fresh) this.#push({ type: "message", record }, data.owner);
        })
        .catch(() => undefined); // a failed append must not break the terminal
    }
  }

  #failConsole(ws: WsClient, message: string): void {
    const state = this.#consoles.get(ws);
    if (state !== undefined) state.closed = true;
    endConsole(ws, { t: "error", message });
  }

  // GET /api/agents/:name/tokens (§12.8, FR-103): the peer's token-usage series
  // (two-zone histogram + live gauge). Same neighbor gate as screen/actions
  // (§10.2). Absent port or untracked type ⇒ 404 (no widget renders).
  handleAgentTokens(url: URL, me: Identity): Response {
    const ports = me.ports;
    if (ports?.tokenSeries === undefined) return json({ error: "token tracking not wired" }, 503);
    const rest = url.pathname.slice("/api/agents/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || rest.slice(slash + 1) !== "tokens") return json({ error: "not found" }, 404);
    const name = decodeURIComponent(rest.slice(0, slash));
    if (!ports.listPeers().includes(name)) {
      return json({ error: `unknown agent "${name}"` }, 404); // not a neighbor (§10.2)
    }
    const series = ports.tokenSeries(name);
    if (series === undefined) return json({ error: `no token tracking for "${name}"` }, 404);
    return json({ ok: true, series });
  }

  // GET /api/history/:agent?before&limit (§12.4): cursor paging backwards.
  // The user's OWN name is the self-chat (§17.7, FR-128) and answers with the
  // PROJECTION instead of the `<user>/<user>.jsonl` pair: every record of this
  // user, both directions, merged into one thread — the aggregate inbox. The
  // same cursor contract, so the panel pages it like any other chat.
  async handleHistory(url: URL, me: Identity): Promise<Response> {
    const history = me.history;
    if (history === undefined) return json({ records: [] });
    const peer = decodeURIComponent(url.pathname.slice("/api/history/".length));
    if (peer.length === 0) return json({ error: "agent name required" }, 400);
    const before = url.searchParams.get("before") ?? undefined;
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const cursor = { ...(before !== undefined ? { before } : {}), limit };
    const self = me.isUser && peer === me.name;
    const page = self ? await history.projected(cursor) : await history.page(peer, cursor);
    // Reactions ride BESIDE the records (§19.5), never inside them: an envelope
    // stays verbatim (§5.3) wherever it is served — page, export, projection.
    const reactions = await this.#options.reactions?.pageMap(
      me.name,
      peer,
      page.records.map((record) => record.id),
      { merged: self }, // the self-chat thread is merged across every pair (§17.7)
    );
    return json({ ...page, ...(reactions !== undefined ? { reactions } : {}) });
  }

  // GET /api/reactions (§19.5, FR-161/FR-166): the declared catalog plus the
  // frequency order of the Recent block. Read at picker-open time — there is no
  // WS push for frequencies on purpose (R3: the list is tiny, and a Recent block
  // that reshuffles under the cursor is a nuisance, §19.8).
  handleReactionCatalog(): Response {
    const hub = this.#options.reactions;
    if (hub === undefined || !hub.enabled) {
      return json({ error: "reactions are not configured", code: "REACTIONS_DISABLED" }, 409);
    }
    return json(hub.catalog());
  }

  // POST   /api/history/:peer/messages/:id/reactions      {key}  — place (§19.5)
  // DELETE /api/history/:peer/messages/:id/reactions/:key        — remove MY OWN
  //
  // Structurally owner-scoped (§10.22): the route addresses the logged-in user's
  // own pair, so another user's chat is unreachable rather than merely forbidden.
  async handleReaction(
    route: { peer: string; messageId: string; key?: string },
    req: Request,
    me: Identity,
  ): Promise<Response> {
    const hub = this.#options.reactions;
    if (hub === undefined || !hub.enabled) {
      return json({ error: "reactions are not configured", code: "REACTIONS_DISABLED" }, 409);
    }
    const remove = req.method === "DELETE";
    let key = route.key;
    if (!remove) {
      if (key !== undefined) return json({ error: "not found" }, 404); // POST takes a body
      const body = await readJsonObject(req);
      const fromBody = body?.key;
      if (typeof fromBody !== "string" || fromBody.length === 0) {
        return json({ error: '"key" (non-empty string) is required' }, 400);
      }
      key = fromBody;
    }
    if (key === undefined) return json({ error: "reaction key required" }, 400);
    const outcome = await hub.react({
      owner: me.name,
      peer: route.peer,
      messageId: route.messageId,
      actor: me.name,
      key,
      ...(remove ? { remove: true } : {}),
    });
    if (!outcome.ok) {
      const status =
        outcome.code === "UNKNOWN_MESSAGE" || outcome.code === "NOT_REACTABLE"
          ? 404
          : outcome.code === "REACTIONS_DISABLED"
            ? 409
            : outcome.code === "REACTION_DENIED"
              ? 403
              : 400;
      return json({ error: outcome.message, code: outcome.code }, status);
    }
    return json({
      ok: true,
      peer: route.peer,
      messageId: route.messageId,
      reactions: outcome.reactions,
      // The notification's fate travels with the answer (§19.6): a reaction whose
      // notice was refused (paused agent, WIP cap) is still PLACED, and the panel
      // shows why in the badge popup instead of losing it silently (the T239 rule).
      ...(outcome.notify !== undefined ? { notify: outcome.notify } : {}),
    });
  }

  // GET /api/prompts (§20.3, FR-184): the signed-in user's whole rack.
  async handlePromptLibrary(me: Identity): Promise<Response> {
    const store = this.#options.prompts;
    if (store === undefined) return json({ error: "prompt library is not wired" }, 503);
    try {
      return json({ library: await store.library(me.name) });
    } catch (error) {
      return promptFailure(error);
    }
  }

  /**
   * The six mutations of the rack (§20.3, FR-184). Pointwise on purpose — a whole
   * document PUT would let one tab of a user overwrite what another just added.
   * Every answer carries the rack AFTER the change: both the composer menu and the
   * page draw the server's truth, with no client-side merge to disagree with it.
   */
  async handlePrompts(
    route: { kind: "shelves" | "items"; id?: string },
    req: Request,
    me: Identity,
  ): Promise<Response> {
    const store = this.#options.prompts;
    if (store === undefined) return json({ error: "prompt library is not wired" }, 503);
    const owner = me.name;
    const wantsBody = req.method === "POST" || req.method === "PATCH";
    if (!wantsBody && req.method !== "DELETE") return json({ error: "not found" }, 404);
    if (req.method === "POST" && route.id !== undefined) return json({ error: "not found" }, 404);
    if (req.method !== "POST" && route.id === undefined) return json({ error: "not found" }, 404);
    let body: Record<string, unknown> = {};
    if (wantsBody) {
      const parsed = await readJsonObject(req);
      if (parsed === undefined) return json({ error: "a JSON object body is required" }, 400);
      body = parsed;
    }
    try {
      const library = await this.#applyPrompt(store, owner, route, req.method, body);
      return json({ library });
    } catch (error) {
      return promptFailure(error);
    }
  }

  #applyPrompt(
    store: PromptStore,
    owner: string,
    route: { kind: "shelves" | "items"; id?: string },
    method: string,
    body: Record<string, unknown>,
  ): Promise<PromptLibrary> {
    const id = route.id ?? "";
    if (route.kind === "shelves") {
      if (method === "POST") return store.createShelf(owner, asName(body.name));
      if (method === "DELETE") return store.deleteShelf(owner, id);
      return store.updateShelf(owner, id, {
        ...(body.name !== undefined ? { name: asName(body.name) } : {}),
        ...(body.position !== undefined ? { position: asPosition(body.position) } : {}),
      });
    }
    if (method === "POST") {
      return store.createPrompt(owner, {
        shelf: asId(body.shelf, "shelf"),
        name: asName(body.name),
        text: asText(body.text),
      });
    }
    if (method === "DELETE") return store.deletePrompt(owner, id);
    return store.updatePrompt(owner, id, {
      ...(body.name !== undefined ? { name: asName(body.name) } : {}),
      ...(body.text !== undefined ? { text: asText(body.text) } : {}),
      ...(body.shelf !== undefined ? { shelf: asId(body.shelf, "shelf") } : {}),
      ...(body.position !== undefined ? { position: asPosition(body.position) } : {}),
    });
  }

  // GET /api/history/:agent/export (FR-84, §12.3): the peer's FULL log as a
  // downloadable JSON document — records verbatim plus enough metadata to know
  // what (and when) was saved. Behind the auth gate like everything else.
  async handleExport(peer: string, me: Identity): Promise<Response> {
    const history = me.history;
    if (history === undefined) return json({ error: "history is not wired" }, 503);
    if (peer.length === 0) return json({ error: "agent name required" }, 400);
    const now = (this.#options.now ?? Date.now)();
    const records = await history.all(peer);
    // Reactions travel as a SIBLING field (§19.5), so `records` stays verbatim; the
    // document version says 2 because its shape changed, not its record contract.
    const reactions = await this.#options.reactions?.pageMap(
      me.name,
      peer,
      records.map((record) => record.id),
    );
    const body = {
      format: "muxeon-chat-history",
      version: 2,
      operator: me.name,
      peer,
      exportedAt: now,
      records,
      ...(reactions !== undefined ? { reactions } : {}),
    };
    const safePeer = peer.replace(/[^\w.-]/g, "_"); // header-safe (§8.7)
    const day = new Date(now).toISOString().slice(0, 10);
    return new Response(`${JSON.stringify(body, null, 2)}\n`, {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        "content-disposition": `attachment; filename="chat-${safePeer}-${day}.json"`,
      },
    });
  }

  // POST /api/history/:agent/clear (FR-84, §12.3): drop the pair's whole log.
  // Every connected tab gets the WS push and empties the thread live; blob
  // bytes referenced only by the cleared log go to the next GC sweep (§5.4).
  async handleClear(peer: string, me: Identity): Promise<Response> {
    const history = me.history;
    if (history === undefined) return json({ error: "history is not wired" }, 503);
    if (peer.length === 0) return json({ error: "agent name required" }, 400);
    await history.clear(peer);
    await this.#options.reactions?.clear(me.name, peer); // the sidecar goes too (§19.4)
    this.#push({ type: "history-cleared", peer }, me.name);
    return json({ ok: true, peer });
  }

  // GET /api/transport?before&limit (FR-48, §12.4): the server-wide transport
  // log (§8.2), agent↔agent included — read-only observability, cursor paging
  // backwards like the history. Behind the same auth gate (§10.12).
  async handleTransport(url: URL, me: Identity): Promise<Response> {
    const transport = this.#options.transport;
    if (transport === undefined) return json({ error: "transport log not wired" }, 503);
    // Role gate (§17.7, FR-131): the server-wide journal is an admin capability.
    // A plain user sees their own communication in their chats — not everyone's.
    if (me.role !== "admin") {
      return json({ error: "the transport journal is available to admins only (§17.7)" }, 403);
    }
    const before = url.searchParams.get("before") ?? undefined;
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const page = await transport.page({ ...(before !== undefined ? { before } : {}), limit });
    // Reactions of the rows on THIS page (§19.13, FR-182) — agent↔agent only, and
    // folded for nobody: the journal shows what was placed, never "mine".
    const reactions = await this.#options.reactions?.journalMap(page.records);
    return json({ ...page, ...(reactions !== undefined ? { reactions } : {}) });
  }

  // POST /api/read {peer}: move the unread watermark (§12.7 badges).
  async handleRead(req: Request, me: Identity): Promise<Response> {
    const body = await readJsonObject(req);
    const peer = body?.peer;
    if (typeof peer !== "string" || peer.length === 0) {
      return json({ error: '"peer" (non-empty string) is required' }, 400);
    }
    await me.history?.markRead(peer);
    return json({ ok: true });
  }

  // POST /api/blobs (multipart "file") → tmp+rename under <root>/blobs/ (§12.5).
  // Caps BEFORE the write: size ≤ maxBytes, mime against the allowlist. The mime
  // is the browser's claim — recorded once here, never re-trusted per request
  // (§12.6); byte access stays behind containment (§8.7) either way.
  async handleUpload(req: Request): Promise<Response> {
    const blobs = this.#options.blobs;
    if (blobs === undefined) return json({ error: "blob store not wired" }, 503);
    let file: File | null = null;
    try {
      const form = await req.formData();
      const entry = form.get("file");
      file = entry instanceof File ? entry : null;
    } catch {
      return json({ error: 'multipart form with a "file" field is required' }, 400);
    }
    if (file === null) {
      return json({ error: 'multipart form with a "file" field is required' }, 400);
    }
    const maxBytes = this.#options.upload?.maxBytes ?? UPLOAD_DEFAULT_MAX_BYTES;
    if (file.size > maxBytes) {
      return json({ error: `file exceeds the ${maxBytes}-byte upload cap (§12.5)` }, 413);
    }
    const mime = file.type === "" ? "application/octet-stream" : file.type;
    const allowlist = this.#options.upload?.mime ?? UPLOAD_DEFAULT_MIME;
    if (!mimeAllowed(mime, allowlist)) {
      return json({ error: `media type "${mime}" is not allowed (§12.5)` }, 415);
    }
    const id = await blobs.write(new Uint8Array(await file.arrayBuffer()), {
      name: file.name,
      mime,
    });
    const name = file.name === "" ? id : file.name;
    this.#blobMeta.set(id, { name, mime, size: file.size });
    return json({ id, name, mime, size: file.size });
  }

  // GET /api/blobs/:id (§12.5): bytes under realpath-containment (§8.7/§10.11).
  // Mime/name come from the upload cache or the history record — never from the
  // request; non-inline types download as attachments (§12.6).
  async handleDownload(url: URL, me: Identity): Promise<Response> {
    const blobs = this.#options.blobs;
    if (blobs === undefined) return json({ error: "blob store not wired" }, 503);
    const id = decodeURIComponent(url.pathname.slice("/api/blobs/".length));
    if (id.length === 0) return json({ error: "blob id required" }, 400);
    let bytes: Uint8Array;
    try {
      bytes = await blobs.read(id); // containment: traversal/symlink → throw (§8.7)
    } catch {
      return json({ error: "blob not found" }, 404); // no path details leak (§8.7)
    }
    // Name/mime come from the upload cache or from the CALLER's own history
    // (§10.22) — never from another user's log, and never from the request.
    const meta = this.#blobMeta.get(id) ?? (await me.history?.findBlobRef(id));
    const mime = meta?.mime ?? "application/octet-stream";
    const inline = INLINE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
    const name = (meta?.name ?? id).replace(/[^\w. -]/g, "_"); // header-safe (§8.7)
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": mime,
        ...(inline ? {} : { "content-disposition": `attachment; filename="${name}"` }),
      },
    });
  }

  // GET <non-api> → the built SPA (§12.7). Only clean relative segments are
  // joined (no "..", no hidden files — §8.7); an extension-less miss falls back
  // to index.html (SPA routing), an asset miss is 404.
  async serveStatic(pathname: string, req?: Request): Promise<Response> {
    const staticDir = this.#options.staticDir;
    if (staticDir === undefined) return json({ error: "not found" }, 404);
    const segments = decodeURIComponent(pathname)
      .split("/")
      .filter((segment) => segment !== "");
    if (segments.some((segment) => segment === ".." || segment.startsWith("."))) {
      return json({ error: "not found" }, 404);
    }
    const relative = segments.length === 0 ? "index.html" : segments.join("/");
    let file = Bun.file(join(staticDir, relative));
    let isShell = relative === "index.html";
    if (!(await file.exists())) {
      if (relative.includes(".")) return json({ error: "not found" }, 404);
      file = Bun.file(join(staticDir, "index.html")); // SPA fallback
      isShell = true;
      if (!(await file.exists())) return json({ error: "not found" }, 404);
    }
    // The SPA shell carries the instance label (FR-90) and, since §17.2, the
    // identity MODE (FR-127) — the login form asks for a user name only where
    // there is one to ask for. Other assets stream as-is.
    if (isShell) {
      const name = this.#options.instanceName;
      const shell = brandShell(await file.text(), name ?? "", this.#usersMode);
      // The shell is GENERATED (the label and the mode are injected), so its tag
      // comes from the bytes actually served — the same file under a renamed
      // instance is a different answer.
      const etag = `"${Bun.hash(shell).toString(16)}"`;
      if (isFresh(req, etag)) return notModified(etag);
      return new Response(shell, {
        headers: { ...cacheHeaders(etag), "content-type": "text/html; charset=utf-8" },
      });
    }
    // An asset's tag is its identity on disk (mtime + size): a rebuild rewrites
    // both, an untouched file keeps them, and nothing has to be read to know.
    const etag = `"${file.lastModified.toString(16)}-${file.size.toString(16)}"`;
    if (isFresh(req, etag)) return notModified(etag);
    return new Response(file, {
      headers: {
        ...cacheHeaders(etag),
        "content-type": file.type || "application/octet-stream",
      },
    });
  }

  /**
   * Push one event to the tabs of ONE identity (§10.22): a socket carries the
   * user it was upgraded for, so a record can never reach another user's browser.
   * `owner === undefined` (legacy, no identities) pushes to every socket.
   */
  #push(event: WebchatEvent, owner?: string): void {
    if (this.#clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of this.#clients) {
      const clientOwner = (client.data as { owner?: string } | undefined)?.owner;
      if (owner !== undefined && clientOwner !== undefined && clientOwner !== owner) continue;
      try {
        client.send(data);
      } catch {
        // a closing socket — the close handler will drop it
      }
    }
  }

  // Panel markers for one peer (§8.2): WIP-cap red name (FR-104) + rendezvous arrows
  // (FR-105). `rz` is read once per pass so membership is a cheap array check.
  #peerMarks(
    name: string,
    depth: number,
    rz: { readonly waiting: readonly string[]; readonly awaited: readonly string[] },
    ports: WebchatPorts | undefined,
  ): { atWipLimit: boolean; waiting: boolean; awaited: boolean } {
    const limit = ports?.wipLimitOf?.(name) ?? null;
    return {
      atWipLimit: limit !== null && depth >= limit,
      waiting: rz.waiting.includes(name),
      awaited: rz.awaited.includes(name),
    };
  }

  // One dynamics tick (§12.7): status/queue-depth/presence diffs per peer + phase
  // moves of tracked outgoing ids — for EACH identity over its own peers (§10.22).
  // Reads only (§10.8); failures are skipped, not fatal.
  async #pollOnce(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      for (const identity of this.#identities.values()) {
        const ports = identity.ports;
        if (ports === undefined) continue;
        const rz = ports.rendezvousState?.() ?? { waiting: [], awaited: [] };
        // The identity's own DND state rides along (§17.8) so the self-chat switch
        // repaints in every tab; a legacy operator is never pausable (§16.1).
        const watched = identity.isUser ? [...ports.listPeers(), identity.name] : ports.listPeers();
        for (const peer of watched) {
          const isUserPeer = ports.peerType?.(peer) === "user" || peer === identity.name;
          const status = isUserPeer ? undefined : ports.peerStatus(peer);
          // Pause (§16.6, FR-119) rides the same diff, so a flip made in one tab
          // repaints the marker in every other one without a reload.
          const paused = ports.peerPaused?.(peer) ?? false;
          const depth = isUserPeer ? 0 : await ports.queueDepth(peer).catch(() => 0);
          const { atWipLimit, waiting, awaited } = isUserPeer
            ? { atWipLimit: false, waiting: false, awaited: false }
            : this.#peerMarks(peer, depth, rz, ports);
          // Presence (§17.5, FR-133) — the user-peer counterpart of a status dot.
          const presence = isUserPeer ? ports.peerPresence?.(peer) : undefined;
          const key = `${identity.name} ${peer}`;
          const seen = this.#dynamics.get(key);
          if (
            seen === undefined ||
            seen.status !== status ||
            seen.paused !== paused ||
            seen.depth !== depth ||
            seen.atWipLimit !== atWipLimit ||
            seen.waiting !== waiting ||
            seen.awaited !== awaited ||
            seen.presence !== presence
          ) {
            this.#dynamics.set(key, {
              status,
              paused,
              depth,
              atWipLimit,
              waiting,
              awaited,
              presence,
            });
            this.#push(
              {
                type: "status",
                peer,
                status,
                paused,
                queueDepth: depth,
                atWipLimit,
                waiting,
                awaited,
                ...(presence !== undefined ? { presence } : {}),
              },
              identity.name,
            );
          }
        }
      }
      // Federated peers (§18.4, FR-150) join the same diff loop — one push
      // mechanism, the panel learns no second one. The registry read is cheap;
      // coalescing already happened on the link (statusDebounceMs).
      for (const identity of this.#identities.values()) {
        const ports = identity.ports;
        if (ports?.remotePeers === undefined) continue;
        for (const peer of ports.remotePeers()) {
          const key = `${identity.name} ${peer.name}`;
          const seen = this.#dynamics.get(key);
          const presence = peer.presence;
          if (
            seen === undefined ||
            seen.status !== peer.status ||
            seen.paused !== peer.paused ||
            seen.presence !== presence ||
            seen.link !== peer.link
          ) {
            this.#dynamics.set(key, {
              status: peer.status,
              paused: peer.paused,
              depth: 0,
              atWipLimit: false,
              waiting: false,
              awaited: false,
              presence,
              link: peer.link,
            });
            this.#push(
              {
                type: "status",
                peer: peer.name,
                ...(peer.status !== undefined ? { status: peer.status } : {}),
                paused: peer.paused,
                queueDepth: 0,
                atWipLimit: false,
                waiting: false,
                awaited: false,
                ...(presence !== undefined ? { presence } : {}),
                server: peer.server,
                link: peer.link,
                ...(peer.reason !== undefined ? { reason: peer.reason } : {}),
              },
              identity.name,
            );
          }
        }
      }
      for (const [id, tracked] of this.#tracked) {
        const ports = this.#identities.get(tracked.owner)?.ports;
        if (ports === undefined) continue;
        const phase = await ports.messagePhase(tracked.to, id).catch(() => undefined);
        if (phase !== undefined && phase !== tracked.phase) {
          tracked.phase = phase;
          this.#push({ type: "queue-progress", id, to: tracked.to, phase }, tracked.owner);
          if (phase === "done" || phase === "failed") this.#tracked.delete(id);
        }
      }
    } finally {
      this.#polling = false;
    }
  }
}

/** HTML-attribute/text escape — the instance label is operator-set config, but the
 *  shell still escapes it so a stray `<`/`"` can never break out of title/meta (§12.6). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Brand the SPA shell: the instance label (FR-90) as `<title><name> - Muxeon</title>`
 * plus a `<meta name="muxeon-name">` the topbar reads, and the identity mode
 * (§17.2, FR-127) as `<meta name="muxeon-auth">`. An empty label leaves the title
 * alone; missing markers leave the shell as-is.
 */
function brandShell(html: string, name: string, usersMode: boolean): string {
  const safe = escapeHtml(name);
  const metas = [
    ...(name !== "" ? [`<meta name="muxeon-name" content="${safe}" />`] : []),
    ...(usersMode ? ['<meta name="muxeon-auth" content="users" />'] : []),
  ];
  const titled =
    name === "" ? html : html.replace(/<title>[^<]*<\/title>/, `<title>${safe} - Muxeon</title>`);
  if (metas.length === 0) return titled;
  return titled.replace(/<\/head>/, `  ${metas.join("\n  ")}\n  </head>`);
}

/** "image/*"-style allowlist match: exact, or a prefix wildcard (§12.5). */
function mimeAllowed(mime: string, allowlist: readonly string[]): boolean {
  return allowlist.some((pattern) =>
    pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern,
  );
}

/** Short text preview of a payload for the peer list (§12.7). */
function preview(payload: unknown): string {
  const normalized = normalizePayload(payload);
  const text = normalized.text ?? "";
  const blobs = normalized.blobs.length > 0 ? `[${normalized.blobs.length} attachment(s)]` : "";
  return `${text} ${blobs}`.trim().slice(0, 120);
}

/**
 * /api/history/<peer>/messages/<id>/reactions[/<key>] by segments (§19.5, FR-162);
 * null = not a reaction route. Matched by SEGMENTS like export/clear, so a peer or
 * an id that happens to be spelled "messages" or "reactions" cannot shift the shape.
 */
function reactionRoute(pathname: string): { peer: string; messageId: string; key?: string } | null {
  if (!pathname.startsWith("/api/history/")) return null;
  const segments = pathname.slice("/api/history/".length).split("/");
  if (segments.length !== 4 && segments.length !== 5) return null;
  if (segments[1] !== "messages" || segments[3] !== "reactions") return null;
  const peer = decodeURIComponent(segments[0] ?? "");
  const messageId = decodeURIComponent(segments[2] ?? "");
  if (peer.length === 0 || messageId.length === 0) return null;
  const key = segments.length === 5 ? decodeURIComponent(segments[4] ?? "") : undefined;
  if (segments.length === 5 && (key === undefined || key.length === 0)) return null;
  return { peer, messageId, ...(key !== undefined ? { key } : {}) };
}

/**
 * /api/prompts/(shelves|items)[/<id>] by segments (§20.3); null = not a rack route.
 * No owner segment exists by design (§10.32) — the rack is the session's.
 */
function promptRoute(pathname: string): { kind: "shelves" | "items"; id?: string } | null {
  if (!pathname.startsWith("/api/prompts/")) return null;
  const segments = pathname.slice("/api/prompts/".length).split("/");
  if (segments.length !== 1 && segments.length !== 2) return null;
  const kind = segments[0];
  if (kind !== "shelves" && kind !== "items") return null;
  if (segments.length === 1) return { kind };
  const id = decodeURIComponent(segments[1] ?? "");
  return id.length === 0 ? null : { kind, id };
}

/** A refusal of the rack (§20.3) as a status: unknown → 404, bad input → 422, broken file → 500. */
function promptFailure(error: unknown): Response {
  if (!(error instanceof PromptError)) throw error;
  const status =
    error.code === "UNKNOWN_SHELF" || error.code === "UNKNOWN_PROMPT"
      ? 404
      : error.code === "LIBRARY_UNREADABLE"
        ? 500
        : 422;
  return json(
    {
      error: error.message,
      code: error.code,
      ...(error.field !== undefined ? { field: error.field } : {}),
    },
    status,
  );
}

function asName(raw: unknown): string {
  if (typeof raw !== "string") throw new PromptError("INVALID", '"name" must be a string', "name");
  return raw;
}

function asText(raw: unknown): string {
  if (typeof raw !== "string") throw new PromptError("INVALID", '"text" must be a string', "text");
  return raw;
}

function asId(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PromptError("INVALID", `"${field}" (non-empty string) is required`, field);
  }
  return raw;
}

function asPosition(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new PromptError("INVALID", '"position" must be a non-negative number', "position");
  }
  return raw;
}

/** /api/history/<peer>/(export|clear) by segments (FR-84); null = not a sub-route. */
function historySubRoute(pathname: string): { peer: string; action: "export" | "clear" } | null {
  if (!pathname.startsWith("/api/history/")) return null;
  const segments = pathname.slice("/api/history/".length).split("/");
  if (segments.length !== 2) return null;
  const action = segments[1];
  if (action !== "export" && action !== "clear") return null;
  return { peer: decodeURIComponent(segments[0] ?? ""), action };
}

function sessionToken(req: Request): string {
  const cookies = req.headers.get("cookie");
  if (cookies === null) return "";
  for (const pair of cookies.split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === SESSION_COOKIE) {
      return pair.slice(eq + 1).trim();
    }
  }
  return "";
}

// Origin must match the host the request was addressed to — directly or via the
// reverse-proxy's forwarded host (§12.6). No Origin (curl, same-origin GET) passes;
// the cookie is httpOnly+SameSite, this check is the cross-site POST backstop.
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return (
    originHost === req.headers.get("host") || originHost === req.headers.get("x-forwarded-host")
  );
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
