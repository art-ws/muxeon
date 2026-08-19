// REST + WS client of the webchat surface (§12.4). All paths are RELATIVE —
// the panel works at any proxy prefix (§12.6). The session cookie is httpOnly;
// the client never sees the token, fetch just carries it.

import type { ServerInfo } from "./server-info";
import type {
  BlobMeta,
  HistoryPage,
  PanelEvent,
  PeerInfo,
  ReactionCatalog,
  ReactionNotify,
  ReactionView,
  TokenSeries,
} from "./types";

/** Client-generated message id — the §10.9 idempotency key for send retries. */
export const newMessageId = (): string => crypto.randomUUID();

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status);
  return body;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Login (§12.6, §17.4): `user` is required in users mode (FR-127) and ignored by
 * a legacy single-operator panel, so it is simply omitted when empty.
 */
export async function login(password: string, user?: string): Promise<void> {
  await jsonOrThrow(
    await fetch("api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, ...(user !== undefined && user !== "" ? { user } : {}) }),
    }),
  );
}

export async function fetchPeers(): Promise<{
  peers: readonly PeerInfo[];
  /** The bound operator's name (FR-68) — the sidebar account button. */
  operator?: string;
  /**
   * The logged-in user (§17.7, FR-127); equals `operator` in legacy mode. In
   * users mode `peers` also carries a row for this very name — the self-chat
   * (FR-128), an ordinary user row.
   */
  user?: string;
  /** Panel role (§17.7, FR-131): only "admin" sees the transport journal. */
  role?: "admin" | "user";
}> {
  return jsonOrThrow<{
    peers: readonly PeerInfo[];
    operator?: string;
    user?: string;
    role?: "admin" | "user";
  }>(await fetch("api/peers"));
}

/**
 * When the current session dies (FR-86) — feeds the auto-renewal schedule — plus
 * WHO it belongs to and with which role (§17.7, FR-127/FR-131).
 */
export async function sessionInfo(): Promise<{
  expiresAt?: number;
  user?: string;
  role?: "admin" | "user";
  title?: string;
  selfChat?: boolean;
}> {
  return jsonOrThrow<{
    expiresAt?: number;
    user?: string;
    role?: "admin" | "user";
    title?: string;
    selfChat?: boolean;
  }>(await fetch("api/session"));
}

/** The server's build info (FR-91) — version + commit + build time; Settings footer. */
export async function fetchServerInfo(): Promise<ServerInfo> {
  return jsonOrThrow<ServerInfo>(await fetch("api/server"));
}

/** Slide the session's expiry by the server's renewal window (T125, FR-86). */
export async function renewSession(): Promise<{ expiresAt?: number }> {
  return jsonOrThrow<{ expiresAt?: number }>(await fetch("api/session/renew", { method: "POST" }));
}

/** Logout (FR-68): the server revokes the session and expires the cookie. */
export async function logout(): Promise<void> {
  await jsonOrThrow(await fetch("api/logout", { method: "POST" }));
}

export async function fetchHistory(peer: string, before?: string): Promise<HistoryPage> {
  const query = before !== undefined ? `?before=${encodeURIComponent(before)}` : "";
  return jsonOrThrow<HistoryPage>(await fetch(`api/history/${encodeURIComponent(peer)}${query}`));
}

export async function sendMessage(options: {
  to: string;
  id: string;
  text?: string;
  blobs?: readonly string[];
  /** Quoted message id (FR-178): the envelope's `replyTo`, not part of the text. */
  replyTo?: string;
}): Promise<void> {
  await jsonOrThrow(
    await fetch("api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    }),
  );
}

export async function uploadBlob(file: File): Promise<BlobMeta> {
  const form = new FormData();
  form.set("file", file);
  return jsonOrThrow<BlobMeta>(await fetch("api/blobs", { method: "POST", body: form }));
}

export const blobUrl = (id: string): string => `api/blobs/${encodeURIComponent(id)}`;

/**
 * The reaction catalog + Recent order (§19.5, FR-161/FR-166). Read when the picker
 * OPENS: the frequency order is global and changes as people react, and there is no
 * push for it on purpose — a Recent block reshuffling under the cursor is a nuisance
 * (§19.8). A 409 (no catalog configured) throws {@link ApiError} with
 * REACTIONS_DISABLED, and the caller simply renders no picker.
 */
export async function fetchReactionCatalog(): Promise<ReactionCatalog> {
  return jsonOrThrow<ReactionCatalog>(await fetch("api/reactions"));
}

const reactionPath = (peer: string, messageId: string): string =>
  `api/history/${encodeURIComponent(peer)}/messages/${encodeURIComponent(messageId)}/reactions`;

/** Place one reaction (§19.5, FR-162) — resolves to the message's folded state. */
export async function placeReaction(
  peer: string,
  messageId: string,
  key: string,
): Promise<{ reactions: readonly ReactionView[]; notify?: ReactionNotify }> {
  return jsonOrThrow<{ reactions: readonly ReactionView[]; notify?: ReactionNotify }>(
    await fetch(reactionPath(peer, messageId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  );
}

/** Remove MY OWN reaction (§19.5) — someone else's is not addressable here. */
export async function removeReaction(
  peer: string,
  messageId: string,
  key: string,
): Promise<{ reactions: readonly ReactionView[] }> {
  return jsonOrThrow<{ reactions: readonly ReactionView[] }>(
    await fetch(`${reactionPath(peer, messageId)}/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  );
}

/** The server-wide transport log page (FR-48, §12.4) — read-only. */
export async function fetchTransport(before?: string): Promise<HistoryPage> {
  const query = before !== undefined ? `?before=${encodeURIComponent(before)}` : "";
  return jsonOrThrow<HistoryPage>(await fetch(`api/transport${query}`));
}

/** Agent lifecycle from the panel (FR-65): graceful shutdown / reload. */
export async function agentAction(
  name: string,
  action: "shutdown" | "reload",
): Promise<{ status: string }> {
  return jsonOrThrow<{ status: string }>(
    await fetch(`api/agents/${encodeURIComponent(name)}/${action}`, { method: "POST" }),
  );
}

/**
 * Pause / resume the agent's communications (§16.5, FR-119). The DESIRED state is
 * sent explicitly, never a toggle — a stale tab cannot invert someone else's flip
 * (§16.4). Resolves to the flag as the server now holds it.
 */
export async function setAgentPaused(name: string, paused: boolean): Promise<boolean> {
  const result = await jsonOrThrow<{ paused: boolean }>(
    await fetch(`api/agents/${encodeURIComponent(name)}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused }),
    }),
  );
  return result.paused;
}

/** Run a configured slash command (FR-66); resolves to the console output as-is. */
export async function runAgentCommand(name: string, slash: string): Promise<string> {
  const { output } = await jsonOrThrow<{ output: string }>(
    await fetch(`api/agents/${encodeURIComponent(name)}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slash }),
    }),
  );
  return output;
}

/** One agent's result inside a command-fanout aggregate (§15.8, FR-115). */
export interface CommandFanoutEntry {
  readonly to: string;
  readonly ok: boolean;
  readonly output?: string;
  /** On failure: COMMAND_FAILED (no command/busy/down) or COMMAND_DENIED (not a neighbour). */
  readonly code?: string;
}

/** The command-fanout aggregate (§15.8, FR-115) — one slash to a selector intersection. */
export interface CommandFanoutResult {
  readonly ok: true;
  readonly kind: "command-fanout";
  readonly slash: string;
  readonly selectors: readonly string[];
  readonly targets: readonly string[];
  readonly fanout: readonly CommandFanoutEntry[];
}

/**
 * Run a slash command against the INTERSECTION of a set of selectors
 * (groups/tags/agents) — the operator command-fanout (§15.8, FR-115). A 400
 * (empty/unknown selector) throws {@link ApiError}; a 200 carries the per-agent
 * aggregate (individual failures live in `fanout[].code`).
 */
export async function runCommandFanout(
  slash: string,
  selectors: readonly string[],
): Promise<CommandFanoutResult> {
  return jsonOrThrow<CommandFanoutResult>(
    await fetch("api/agents/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slash, selectors }),
    }),
  );
}

/**
 * The console socket of one agent (§12.9, FR-160): the URL the terminal attaches
 * to. Relative to the document, so it follows the panel's basePath (§12.6) — the
 * same rule the push feed lives by.
 */
export function consoleSocketUrl(name: string): string {
  const base = new URL(".", window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return new URL(`api/agents/${encodeURIComponent(name)}/console`, base).toString();
}

/** A live console snapshot (FR-102): the peer's visible pane as-is — the text
 *  capture, the same one `get_screen` (FR-147) hands an agent. */
export async function fetchAgentScreen(name: string): Promise<string> {
  const { output } = await jsonOrThrow<{ output: string }>(
    await fetch(`api/agents/${encodeURIComponent(name)}/screen`),
  );
  return output;
}

/**
 * The peer's token-usage series (§12.8, FR-103) — the header meter polls this.
 * `undefined` when the agent's type isn't tracked (404) or the port is unwired
 * (503): the widget simply doesn't render.
 */
export async function fetchTokenSeries(name: string): Promise<TokenSeries | undefined> {
  const response = await fetch(`api/agents/${encodeURIComponent(name)}/tokens`);
  if (!response.ok) return undefined;
  const body = (await response.json().catch(() => ({}))) as { series?: TokenSeries };
  return body.series;
}

/** The chat-export download URL (FR-84) — relative, basePath-safe (§12.6). */
export const exportHistoryUrl = (peer: string): string =>
  `api/history/${encodeURIComponent(peer)}/export`;

/** Drop the pair's whole chat log (FR-84); the WS push empties the thread. */
export async function clearHistory(peer: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`api/history/${encodeURIComponent(peer)}/clear`, { method: "POST" }),
  );
}

export async function markRead(peer: string): Promise<void> {
  await jsonOrThrow(
    await fetch("api/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer }),
    }),
  );
}

/**
 * Push-only WS feed (§12.4) with auto-reconnect; `onAuthLost` fires when the
 * session is gone (the server refuses the upgrade) so the app can re-login.
 */
export function connectFeed(handlers: {
  onEvent: (event: PanelEvent) => void;
  onAuthLost: () => void;
}): () => void {
  let socket: WebSocket | undefined;
  let closed = false;
  let retryMs = 500;

  const open = (): void => {
    if (closed) return;
    const base = new URL(".", window.location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(new URL("api/ws", base));
    socket.addEventListener("message", (event) => {
      try {
        handlers.onEvent(JSON.parse(String(event.data)) as PanelEvent);
      } catch {
        // a malformed frame is dropped, the feed lives on
      }
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      retryMs = Math.min(retryMs * 2, 10_000);
      setTimeout(open, retryMs);
    });
    socket.addEventListener("open", () => {
      retryMs = 500;
    });
  };

  // Probe auth first: an expired session must surface as a login screen, not a
  // silent reconnect loop.
  void fetch("api/peers").then((response) => {
    if (response.status === 401) handlers.onAuthLost();
    else open();
  });

  return () => {
    closed = true;
    socket?.close();
  };
}
