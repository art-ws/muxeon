// Telegram connector (§3.2, FR-24a/FR-25a/FR-26) — implements ChannelConnector
// over an injectable TelegramApi (the real Bot API client lives in telegram-api.ts;
// tests inject a fake). Inbound: update → media downloaded to blobs (blob BEFORE
// the referencing enqueue, §5.4) → @agent/defaultTarget addressing → Message →
// onInbound (the router bridge); a refusal or missing target is reported back to
// the operator in the same chat (§3.2). Outbound deliver: text + blob refs resolved
// to bytes only under <root>/blobs/ (BlobStore containment, §8.7) and pushed to the
// last seen chat. The connector never touches the queue (§8, §10.8).

import type { Message, Signal } from "@teamai/core";
import type { BlobStore } from "@teamai/orchestrator";
import { resolveTarget } from "./address";
import {
  type BlobRef,
  type ChannelConnector,
  type InboundHandler,
  normalizePayload,
  operatorErrorText,
  reactionText,
} from "./contract";

/** One inbound chat event, already decoded from the Bot API update. */
export interface TelegramIncoming {
  readonly updateId: number;
  readonly chatId: number | string;
  /** message text or media caption */
  readonly text?: string;
  readonly media?: readonly { readonly fileId: string; readonly name?: string }[];
}

/** The slice of the Telegram Bot API the connector needs; injectable for tests. */
export interface TelegramApi {
  /** Long-poll updates from `offset`; resolves [] on timeout. Aborts with the signal. */
  poll(offset: number, signal: AbortSignal): Promise<readonly TelegramIncoming[]>;
  sendText(chatId: number | string, text: string): Promise<void>;
  sendDocument(
    chatId: number | string,
    document: { readonly bytes: Uint8Array; readonly name: string },
  ): Promise<void>;
  download(fileId: string): Promise<Uint8Array>;
}

export interface TelegramConnectorOptions {
  readonly bindOperator: string;
  readonly defaultTarget?: string;
  readonly api: TelegramApi;
  /** Agent names addressable by @token (§3.2) — the topology's agents. */
  readonly knownAgents: readonly string[];
  /** Blob store under <root>/blobs/ (§5.3, §8.7). */
  readonly blobs: BlobStore;
  readonly now?: () => number;
  /** Backoff after a failed poll (NFR-10); default 1000ms. */
  readonly pollRetryMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramConnector implements ChannelConnector {
  readonly type = "telegram";
  readonly bindOperator: string;
  readonly defaultTarget?: string;
  readonly #api: TelegramApi;
  readonly #knownAgents: ReadonlySet<string>;
  readonly #blobs: BlobStore;
  readonly #now: () => number;
  readonly #pollRetryMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;
  /** Egress destination: the last chat the operator wrote from (§3.2 same-route reply). */
  #chatId: number | string | undefined;
  #offset = 0;

  constructor(options: TelegramConnectorOptions) {
    this.bindOperator = options.bindOperator;
    if (options.defaultTarget !== undefined) this.defaultTarget = options.defaultTarget;
    this.#api = options.api;
    this.#knownAgents = new Set(options.knownAgents);
    this.#blobs = options.blobs;
    this.#now = options.now ?? Date.now;
    this.#pollRetryMs = options.pollRetryMs ?? 1000;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async start(onInbound: InboundHandler): Promise<void> {
    if (this.#loop !== undefined) throw new Error("telegram connector already started");
    this.#loop = this.#run(onInbound);
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
  }

  async #run(onInbound: InboundHandler): Promise<void> {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      let updates: readonly TelegramIncoming[];
      try {
        updates = await this.#api.poll(this.#offset, signal);
      } catch {
        if (signal.aborted) return;
        await this.#sleep(this.#pollRetryMs);
        continue;
      }
      for (const incoming of updates) {
        await this.#handle(incoming, onInbound);
        // Advance only after handling: a crash re-polls the update (at-least-once);
        // the deterministic id below lets the done/ dedup window drop the repeat (§10.9).
        this.#offset = incoming.updateId + 1;
      }
    }
  }

  async #handle(incoming: TelegramIncoming, onInbound: InboundHandler): Promise<void> {
    this.#chatId = incoming.chatId;
    const resolved = resolveTarget(incoming.text, this.#knownAgents, this.defaultTarget);
    if (!resolved.ok) {
      // §3.2: no @agent and no defaultTarget → clear error to the operator, not a crash.
      await this.#reply(
        incoming.chatId,
        "teamai: no recipient — address an agent with @name (no default target is set)",
      );
      return;
    }
    let payload: unknown;
    try {
      payload = await this.#buildPayload(incoming);
    } catch {
      await this.#reply(incoming.chatId, "teamai: failed to fetch the attached media");
      return;
    }
    if (payload === undefined) return; // nothing deliverable (e.g. a service update)
    const message: Message = {
      // Deterministic per update → a re-polled redelivery reuses the id (§5.3/§10.9).
      id: `telegram-${incoming.updateId}`,
      from: this.bindOperator,
      to: resolved.target,
      kind: "message",
      ts: this.#now(),
      payload,
      origin: "telegram",
    };
    try {
      await onInbound(message);
    } catch (error) {
      await this.#reply(incoming.chatId, operatorErrorText(error)); // §3.2, redacted (§8.7)
    }
  }

  /** Media → blob store FIRST (§5.4), payload carries opaque refs only (§5.3). */
  async #buildPayload(incoming: TelegramIncoming): Promise<unknown> {
    const media = incoming.media ?? [];
    if (media.length === 0) return incoming.text;
    const blobs: BlobRef[] = [];
    for (const item of media) {
      const id = await this.#blobs.write(await this.#api.download(item.fileId), {
        name: item.name,
      });
      blobs.push({ blob: id, ...(item.name !== undefined ? { name: item.name } : {}) });
    }
    return { ...(incoming.text !== undefined ? { text: incoming.text } : {}), blobs };
  }

  async #reply(chatId: number | string, text: string): Promise<void> {
    try {
      await this.#api.sendText(chatId, text);
    } catch {
      // best-effort operator notice; the channel itself may be down
    }
  }

  /** Egress sink (§8.4): push text, then each blob as a document. Throw = re-send (§10.9). */
  async deliver(signal: Signal): Promise<void> {
    // Forward-compat kinds (FR-25b, §5.3): a reaction renders as a small notice;
    // an unsupported kind is IGNORED — returning (not throwing) lets the egress
    // dispatcher complete it, so an unknown kind never blocks the queue (§10.9).
    if (signal.kind === "reaction") {
      const chatId = this.#chatId;
      if (chatId === undefined) throw new Error("no telegram chat known yet");
      await this.#api.sendText(chatId, `[${signal.from}] reacted: ${reactionText(signal)}`);
      return;
    }
    if (signal.kind !== "message") return; // unsupported kind — ignore, complete
    const chatId = this.#chatId;
    if (chatId === undefined) {
      // No chat seen yet — Bot API cannot initiate. The record stays in cur/ and
      // is re-sent once the operator has written first (at-least-once, §10.9).
      throw new Error("no telegram chat known yet — waiting for the operator to write first");
    }
    const payload = normalizePayload(signal.payload);
    if (payload.text !== undefined) {
      await this.#api.sendText(chatId, `[${signal.from}] ${payload.text}`);
    }
    for (const ref of payload.blobs) {
      const bytes = await this.#blobs.read(ref.blob); // containment under blobs/ (§8.7)
      await this.#api.sendDocument(chatId, { bytes, name: ref.name ?? ref.blob });
    }
  }
}
