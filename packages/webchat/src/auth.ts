// Webchat auth (§12.6, FR-42/FR-57): password login → opaque bearer token in an
// httpOnly cookie. Sessions are TTL-bound (config auth.session.ttl, default 1d)
// and durable when a store file is wired: only SHA-256 hashes of the tokens are
// kept — in memory and on disk — so a leaked store file cannot be replayed as a
// cookie (§8.7), while a server restart no longer logs everyone out. Without a
// file the store is in-memory (the pre-FR-57 behavior, used by tests). Login
// attempts are rate-limited BEFORE the password compare; the compare itself is
// constant-time (hash both sides, timingSafeEqual).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Constant-time password equality: compare SHA-256 digests (equal length). */
export function passwordsEqual(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The spec default for auth.session.ttl (§12.2): "1d". */
export const SESSION_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionStoreOptions {
  /** Session lifetime, ms (config auth.session.ttl §12.2; default 1d). */
  readonly ttlMs?: number;
  /**
   * Renewal extension, ms (config auth.session.renew §12.2, T125/FR-86):
   * a renew() pushes the SAME token's expiry to now + renewMs. Default — the
   * ttl: an actively open panel slides its session forward indefinitely, a
   * closed one dies on schedule.
   */
  readonly renewMs?: number;
  /** Durable store path (§12.6, FR-57); absent ⇒ in-memory (a restart logs out). */
  readonly file?: string;
  readonly now?: () => number;
  readonly newToken?: () => string;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Session tokens (issued on login, checked on every request): sha256(token) →
 * expiry unix_ms. The file (when wired) mirrors the map as a flat JSON object,
 * written tmp+rename with mode 0600; expired entries are swept on every write.
 */
export class SessionStore {
  readonly #sessions = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #renewMs: number;
  readonly #file: string | undefined;
  readonly #now: () => number;
  readonly #newToken: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? SESSION_DEFAULT_TTL_MS;
    this.#renewMs = options.renewMs ?? this.#ttlMs;
    this.#file = options.file;
    this.#now = options.now ?? Date.now;
    this.#newToken = options.newToken ?? (() => randomBytes(32).toString("hex"));
    this.#load();
  }

  /** Session lifetime — the connector mirrors it into the cookie's Max-Age. */
  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Renewal extension (FR-86) — the renewed cookie's Max-Age mirrors it. */
  get renewMs(): number {
    return this.#renewMs;
  }

  issue(): string {
    const token = this.#newToken();
    this.#sessions.set(hashToken(token), this.#now() + this.#ttlMs);
    this.#persist();
    return token;
  }

  has(token: string): boolean {
    const hash = hashToken(token);
    const expiresAt = this.#sessions.get(hash);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.#now()) {
      this.#sessions.delete(hash);
      this.#persist();
      return false;
    }
    return true;
  }

  /** When the token dies (unix_ms) — the §12.4 session endpoint's payload. */
  expiresAt(token: string): number | undefined {
    const expiresAt = this.#sessions.get(hashToken(token));
    return expiresAt !== undefined && expiresAt > this.#now() ? expiresAt : undefined;
  }

  /**
   * Slide the SAME token's expiry to now + renewMs (T125, FR-86) — durable
   * store included. The token itself never changes (nothing new to leak); an
   * expired/unknown token is NOT resurrected — undefined, the caller answers
   * 401 and the panel re-logins.
   */
  renew(token: string): number | undefined {
    if (!this.has(token)) return undefined;
    const expiresAt = this.#now() + this.#renewMs;
    this.#sessions.set(hashToken(token), expiresAt);
    this.#persist();
    return expiresAt;
  }

  /** Logout (FR-68): the token dies server-side too — durable store included. */
  revoke(token: string): void {
    if (this.#sessions.delete(hashToken(token))) this.#persist();
  }

  // A corrupt/missing file starts an empty store — re-login, never a boot crash.
  #load(): void {
    if (this.#file === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const now = this.#now();
    for (const [hash, expiresAt] of Object.entries(parsed)) {
      if (typeof expiresAt === "number" && expiresAt > now) this.#sessions.set(hash, expiresAt);
    }
  }

  // Best-effort: an fs error degrades to in-memory sessions, never breaks login.
  #persist(): void {
    if (this.#file === undefined) return;
    const now = this.#now();
    for (const [hash, expiresAt] of this.#sessions) {
      if (expiresAt <= now) this.#sessions.delete(hash);
    }
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#sessions)), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch {
      // disk hiccup — sessions stay valid in memory for this process
    }
  }
}

export interface RateLimitOptions {
  /** Attempts allowed per window (default 10). */
  readonly maxAttempts?: number;
  /** Window length in ms (default 60s). */
  readonly windowMs?: number;
  readonly now?: () => number;
}

/**
 * Fixed-window login limiter, keyed by client (IP when known, else one global
 * bucket — behind a reverse-proxy all clients share the proxy's IP anyway, so
 * the panel-wide bound is the one that matters).
 */
export class LoginRateLimiter {
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(options: RateLimitOptions = {}) {
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** Registers an attempt; false = over the limit (reject with 429). */
  allow(key: string): boolean {
    const now = this.#now();
    const window = this.#windows.get(key);
    if (window === undefined || now - window.start >= this.#windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.#maxAttempts;
  }
}
