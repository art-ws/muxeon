// Telegram connector (§3.2, FR-24a/FR-25a/FR-26) — implements ChannelConnector
// over an injectable TelegramApi (the real Bot API client lives in telegram-api.ts;
// tests inject a fake). Inbound: update → media downloaded to blobs (blob BEFORE
// the referencing enqueue, §5.4) → @agent/defaultTarget addressing → Message →
// onInbound (the router bridge); a refusal or missing target is reported back to
// the operator in the same chat (§3.2). Outbound deliver: text + blob refs resolved
// to bytes only under <root>/blobs/ (BlobStore containment, §8.7) and pushed to the
// last seen chat. The connector never touches the queue (§8, §10.8).

import type { Message, Signal } from "@muxeon/core";
import type { BlobStore } from "@muxeon/orchestrator";
import { resolveTarget } from "./address";
import {
  type BlobRef,
  type ChannelConnector,
  type InboundHandler,
  normalizePayload,
  operatorErrorText,
  reactionText,
} from "./contract";
import { type ChannelIdentity, resolveUserTarget } from "./identity";

/** One inbound chat event, already decoded from the Bot API update. */
export interface TelegramIncoming {
  readonly updateId: number;
  readonly chatId: number | string;
  /** message text or media caption */
  readonly text?: string;
  readonly media?: readonly { readonly fileId: string; readonly name?: string }[];
  /**
   * Who sent it (§17.6, FR-125): the telegram `username` and/or numeric user id.
   * Used ONLY in users mode, where the sender is resolved to exactly one user
   * through the channel bindings (§10.21). Legacy mode ignores it — everything in
   * the chat is attributed to the bound operator.
   */
  readonly sender?: { readonly username?: string; readonly userId?: number | string };
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
  /** Legacy single-operator binding (§12.1); absent in users mode (§17.2). */
  readonly bindOperator?: string | undefined;
  /**
   * Users-mode identity port (§17.6, FR-125/FR-126): sender alias → user, user →
   * alias (egress), and the sender's addressable peers. Absent ⇒ legacy mode.
   */
  readonly identity?: ChannelIdentity;
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
  readonly bindOperator: string | undefined;
  readonly defaultTarget?: string;
  readonly #identity: ChannelIdentity | undefined;
  /** Users mode (§17.5): alias → the chat that alias last wrote from (egress). */
  readonly #chatByAlias = new Map<string, number | string>();
  /** Ids of self-delivered records that came FROM this channel (§17.6-2c echo skip). */
  readonly #suppressed = new Set<string>();
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
    this.#identity = options.identity;
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
    // Users mode (§17.6): resolve WHO wrote before anything else — an identity with
    // no binding is refused politely and never reaches the router (§10.21, no guests).
    const identity = this.#identity;
    let from = this.bindOperator;
    let self = false;
    let target: string;
    if (identity !== undefined) {
      const sender = this.#senderOf(incoming, identity);
      if (sender === undefined) {
        await this.#reply(
          incoming.chatId,
          "muxeon: this telegram account is not linked to a Muxeon user — ask the operator to bind it",
        );
        return;
      }
      from = sender;
      const alias = identity.aliasOf(sender);
      if (alias !== undefined) this.#chatByAlias.set(alias, incoming.chatId);
      const resolved = resolveUserTarget(incoming.text, sender, identity);
      target = resolved.target;
      self = resolved.self;
    } else {
      const resolved = resolveTarget(incoming.text, this.#knownAgents, this.defaultTarget);
      if (!resolved.ok) {
        // §3.2: no @agent and no defaultTarget → clear error to the operator, not a crash.
        await this.#reply(
          incoming.chatId,
          "muxeon: no recipient — address an agent with @name (no default target is set)",
        );
        return;
      }
      target = resolved.target;
    }
    if (from === undefined) return; // unreachable: legacy always binds an operator
    let payload: unknown;
    try {
      payload = await this.#buildPayload(incoming);
    } catch {
      await this.#reply(incoming.chatId, "muxeon: failed to fetch the attached media");
      return;
    }
    if (payload === undefined) return; // nothing deliverable (e.g. a service update)
    const message: Message = {
      // Deterministic per update → a re-polled redelivery reuses the id (§5.3/§10.9).
      id: `telegram-${incoming.updateId}`,
      from,
      to: target,
      kind: "message",
      ts: this.#now(),
      payload,
      origin: "telegram",
    };
    try {
      await onInbound(message);
      // A self-delivered message (§17.6-2c) echoes back over the user's OTHER
      // channels through their egress fan-out; this chat already shows it, so the
      // source chat is excluded — that exclusion is this flag, read by the server.
      if (self) this.#suppressed.add(message.id);
    } catch (error) {
      await this.#reply(incoming.chatId, operatorErrorText(error)); // §3.2, redacted (§8.7)
    }
  }

  /** Sender → bound user (§17.6-1): by @username first, then by numeric id. */
  #senderOf(incoming: TelegramIncoming, identity: ChannelIdentity): string | undefined {
    const username = incoming.sender?.username;
    const byName = username !== undefined ? identity.userOf(username) : undefined;
    if (byName !== undefined) return byName;
    const userId = incoming.sender?.userId;
    return userId !== undefined ? identity.userOf(String(userId)) : undefined;
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

  /**
   * Users-mode push (§17.5, FR-124): deliver one record to the chat of `alias`.
   * Unlike {@link deliver} this is NOT the queue sink — the user's history already
   * holds the record — so a throw is only logged upstream (best-effort fan-out).
   * A record that originated as self-delivery FROM this chat is skipped: the user
   * already sees it there (§17.6-2c).
   */
  async pushTo(alias: string, signal: Signal): Promise<void> {
    if (this.#suppressed.delete(signal.id)) return;
    const chatId = this.#chatByAlias.get(alias);
    if (chatId === undefined) {
      throw new Error(`no telegram chat known for "${alias}" yet — they must write first`);
    }
    await this.#send(chatId, signal);
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
    await this.#send(chatId, signal);
  }

  /** Text, then each blob as a document — the shared body of deliver/pushTo. */
  async #send(chatId: number | string, signal: Signal): Promise<void> {
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
