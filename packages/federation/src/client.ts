// The link client (§18.7, FR-139): the importer holds ONE persistent WS per
// import — handshake (bearer → instance-id/version/statusPublished), the actor
// surface, then the frame stream. Reconnect with backoff; losing the link loses
// NOTHING queued (§10.25 — the egress dispatcher just re-sends once the link is
// back) and only the status cache (§10.27 — the registry goes `unknown`).

import {
  type ActorsResponse,
  FED_ACTORS_PATH,
  FED_HANDSHAKE_PATH,
  FED_LINK_PATH,
  FED_PROTOCOL_VERSION,
  type HandshakeResponse,
} from "./protocol";

export interface LinkClientOptions {
  /** The import's local name (§18.2) — the FQN tail of everything it brings. */
  readonly name: string;
  readonly url: string;
  readonly token: string;
  /** §18.11/FR-153: ask the hub to relay this server's published surface. */
  readonly publish?: boolean;
  /** §18.11.2: whether the reverse stream will carry statuses (default true). */
  readonly statusPublished?: boolean;
  /** The link is up: handshake + surface seed + the socket's send. */
  readonly onUp: (
    handshake: HandshakeResponse,
    actors: ActorsResponse,
    send: (text: string) => void,
  ) => void;
  readonly onDown: () => void;
  readonly onMessage: (raw: unknown) => void;
  readonly warn?: (message: string) => void;
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 10_000;

function wsUrl(base: string): string {
  const url = new URL(FED_LINK_PATH, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class LinkClient {
  readonly #options: LinkClientOptions;
  #socket: WebSocket | null = null;

  constructor(options: LinkClientOptions) {
    this.#options = options;
  }

  #warn(message: string): void {
    this.#options.warn?.(`federation link "${this.#options.name}": ${message}`);
  }

  /** The connect loop (FR-139): run until aborted; backoff resets on success. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.#options.backoffInitialMs ?? BACKOFF_INITIAL_MS;
    const maxBackoff = this.#options.backoffMaxMs ?? BACKOFF_MAX_MS;
    const onAbort = (): void => this.#socket?.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal.aborted) {
        const connected = await this.#connectOnce(signal);
        if (signal.aborted) break;
        backoff = connected ? (this.#options.backoffInitialMs ?? BACKOFF_INITIAL_MS) : backoff;
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#socket?.close();
    }
  }

  /** One connect attempt; resolves when the socket closes. True = it got up. */
  async #connectOnce(signal: AbortSignal): Promise<boolean> {
    const { url, token } = this.#options;
    const doFetch = this.#options.fetchImpl ?? fetch;
    const headers = { authorization: `Bearer ${token}` };
    let handshake: HandshakeResponse;
    let actors: ActorsResponse;
    try {
      const hsResponse = await doFetch(new URL(FED_HANDSHAKE_PATH, url), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          version: FED_PROTOCOL_VERSION,
          publish: this.#options.publish === true,
          statusPublished: this.#options.statusPublished ?? true,
        }),
      });
      if (!hsResponse.ok) {
        this.#warn(`handshake failed: HTTP ${hsResponse.status}`);
        return false;
      }
      handshake = (await hsResponse.json()) as HandshakeResponse;
      if (handshake.version !== FED_PROTOCOL_VERSION) {
        // Version incompatibility is link-down with a clear log (§18.7), not a guess.
        this.#warn(
          `protocol version mismatch: theirs ${handshake.version}, ours ${FED_PROTOCOL_VERSION}`,
        );
        return false;
      }
      if (this.#options.publish === true && handshake.relay !== true) {
        // Mode mismatch is a warn and base-mode link (§18.11.5) — NEVER link-down;
        // version incompatibility above stays the only link-down cause.
        this.#warn("publish requested but the hub did not grant relay — base link mode (§18.11)");
      }
      const actorsResponse = await doFetch(new URL(FED_ACTORS_PATH, url), { headers });
      if (!actorsResponse.ok) {
        this.#warn(`actors fetch failed: HTTP ${actorsResponse.status}`);
        return false;
      }
      actors = (await actorsResponse.json()) as ActorsResponse;
    } catch (error) {
      this.#warn(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (signal.aborted) return false;

    return await new Promise<boolean>((resolve) => {
      let up = false;
      // Bun's WebSocket takes a headers bag — that is how the bearer travels on
      // the upgrade (a browser could not do this; a server can, §18.7).
      const socket = new WebSocket(wsUrl(url), { headers });
      this.#socket = socket;
      const send = (text: string): void => socket.send(text);
      socket.addEventListener("open", () => {
        up = true;
        this.#options.onUp(handshake, actors, send);
      });
      socket.addEventListener("message", (event) => {
        this.#options.onMessage((event as MessageEvent).data);
      });
      socket.addEventListener("error", () => {
        // close always follows; the close handler owns the teardown
      });
      socket.addEventListener("close", () => {
        if (this.#socket === socket) this.#socket = null;
        if (up) this.#options.onDown();
        resolve(up);
      });
    });
  }
}
