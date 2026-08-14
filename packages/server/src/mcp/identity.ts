// Agent-plane identity binding (§8.1, §8.6). An agent declares its topology name at
// `initialize` via clientInfo.name; the server binds that name to the MCP session
// (Mcp-Session-Id) and every tool call resolves the caller from it. The model is
// COOPERATIVE (§8.1): the server trusts the declared name — topology (§10.2) is a
// routing constraint, not anti-spoofing (a malicious agent declaring a peer's name is
// OOS-6). An unknown name is rejected (not a silent empty peer list); a name already
// bound to a live session is TAKEN OVER (FR-44b, T55): a crashed client never sends
// the closing DELETE, so rejecting the newcomer would leave the name dead until a
// server restart — last-writer-wins, the eviction is surfaced to the caller (logged).

/** Why an initialize was refused (§8.6). */
export type IdentityRejection = "UNKNOWN_IDENTITY";

/** A successful reservation; `evictedSession` is the taken-over session id, if any. */
export interface Reservation {
  readonly evictedSession?: string;
}

/**
 * Tracks live sessions ↔ identities. Reservation is SYNCHRONOUS (no await between the
 * eviction check and the claim) so two concurrent initializes for the same name cannot
 * both win in the single-threaded event loop.
 */
export class SessionRegistry {
  readonly #isKnown: (name: string) => boolean;
  /** name → bound session id, or null while reserved but not yet initialized. */
  readonly #sessionByName = new Map<string, string | null>();
  readonly #nameBySession = new Map<string, string>();

  constructor(isKnownIdentity: (name: string) => boolean) {
    this.#isKnown = isKnownIdentity;
  }

  /**
   * Validate and reserve a declared name at initialize. An existing binding is
   * evicted (takeover, FR-44b) and its session id returned so the caller can drop
   * the dead transport. The caller must then bind() the reservation to the generated
   * session id, or release() it if the session never materializes.
   */
  reserve(name: string): IdentityRejection | Reservation {
    if (!this.#isKnown(name)) return "UNKNOWN_IDENTITY";
    const existing = this.#sessionByName.get(name);
    this.#sessionByName.set(name, null); // reserved, not yet bound
    if (existing === undefined || existing === null) return {};
    this.#nameBySession.delete(existing);
    return { evictedSession: existing };
  }

  /** Undo a reservation whose session failed to come up (connect/handshake threw). */
  release(name: string): void {
    if (this.#sessionByName.get(name) === null) this.#sessionByName.delete(name);
  }

  /** Bind a reserved name to its generated session id (onsessioninitialized). */
  bind(sessionId: string, name: string): void {
    this.#sessionByName.set(name, sessionId);
    this.#nameBySession.set(sessionId, name);
  }

  /**
   * Drop a closed session, freeing its name for reconnection (onsessionclosed).
   * A session already evicted by takeover is a no-op — the name belongs to the
   * newcomer now and must not be freed by the loser's late close.
   */
  drop(sessionId: string): void {
    const name = this.#nameBySession.get(sessionId);
    if (name === undefined) return;
    this.#nameBySession.delete(sessionId);
    if (this.#sessionByName.get(name) === sessionId) this.#sessionByName.delete(name);
  }

  nameOf(sessionId: string): string | undefined {
    return this.#nameBySession.get(sessionId);
  }

  /**
   * Does `name` hold a LIVE agent-plane session right now (§13.6, FR-156)? This is
   * the signal that picks the compact MCP reply contract over the file one — and
   * it is deliberately the only signal used: an agent's `.mcp.json` on disk says
   * what was CONFIGURED, not what connected (T260 — the whole park carried a
   * syntactically valid MCP config pointing at a shim path that no longer existed,
   * and nothing ever came up).
   *
   * A reservation not yet bound (value null — initialize in flight) reads as NOT
   * live: the wrong answer here must be the one that degrades to the file contract,
   * which every agent can follow.
   */
  hasLiveSession(name: string): boolean {
    const bound = this.#sessionByName.get(name);
    return bound !== undefined && bound !== null;
  }
}

/** The clientInfo.name + request id extracted from a raw initialize body. */
export interface InitializeInfo {
  readonly id: string | number | null;
  readonly name: string | undefined;
}

interface JsonRpcInitialize {
  readonly id?: string | number | null;
  readonly method?: unknown;
  readonly params?: { readonly clientInfo?: { readonly name?: unknown } };
}

/**
 * If `bodyText` is a JSON-RPC `initialize` request, return its id and the declared
 * clientInfo.name (name undefined when absent/non-string). Returns null for any other
 * message — the transport then handles it normally (a session request) or rejects it.
 */
export function parseInitialize(bodyText: string): InitializeInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const msg = parsed as JsonRpcInitialize;
  if (msg.method !== "initialize") return null;
  const rawName = msg.params?.clientInfo?.name;
  return {
    id: msg.id ?? null,
    name: typeof rawName === "string" && rawName.length > 0 ? rawName : undefined,
  };
}
