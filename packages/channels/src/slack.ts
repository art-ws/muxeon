// Slack connector (T37/S, FR-24b, §3.2, §8.4) — the second chat connector behind
// the unified interface, validating NFR-7. Same shape as telegram: an injectable
// SlackApi (the real Web-API client lives in slack-api.ts; tests inject a fake),
// inbound media → blobs (blob before enqueue, §5.4), @agent/defaultTarget
// addressing, refusals echoed back to the channel, outbound deliver resolving
// blob refs only under <root>/blobs/ (§8.7). Addressing uses the same plain
// `@name` convention as every channel (Slack <@U…> mention ids are not topology
// names). The connector never touches the queue (§8, §10.8).

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

export interface SlackIncoming {
  /** Stable per-event id (event ts) — the dedup key (§10.9). */
  readonly eventId: string;
  readonly text?: string;
  readonly files?: readonly { readonly id: string; readonly name?: string }[];
  /**
   * Who sent it (§17.6, FR-125): the slack user id (and handle when known). Used
   * ONLY in users mode, where it resolves to exactly one bound user (§10.21).
   */
  readonly sender?: { readonly userId?: string; readonly handle?: string };
}

/** The slice of the Slack API the connector needs; injectable for tests. */
export interface SlackApi {
  /** Fetch events after `cursor`; returns the new events and the advanced cursor. */
  poll(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly incoming: readonly SlackIncoming[]; readonly cursor?: string }>;
  sendText(text: string): Promise<void>;
  sendFile(file: { readonly bytes: Uint8Array; readonly name: string }): Promise<void>;
  download(fileId: string): Promise<Uint8Array>;
}

export interface SlackConnectorOptions {
  /** Legacy single-operator binding (§12.1); absent in users mode (§17.2). */
  readonly bindOperator?: string | undefined;
  /** Users-mode identity port (§17.6, FR-125/FR-126); absent ⇒ legacy mode. */
  readonly identity?: ChannelIdentity;
  readonly defaultTarget?: string;
  readonly api: SlackApi;
  readonly knownAgents: readonly string[];
  readonly blobs: BlobStore;
  readonly now?: () => number;
  /** Idle wait between polls / after a failed poll (NFR-10); default 2000ms. */
  readonly pollIdleMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SlackConnector implements ChannelConnector {
  readonly type = "slack";
  readonly bindOperator: string | undefined;
  readonly defaultTarget?: string;
  readonly #identity: ChannelIdentity | undefined;
  /** Ids of self-delivered records that came FROM this channel (§17.6-2c echo skip). */
  readonly #suppressed = new Set<string>();
  readonly #api: SlackApi;
  readonly #knownAgents: ReadonlySet<string>;
  readonly #blobs: BlobStore;
  readonly #now: () => number;
  readonly #pollIdleMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;
  #cursor: string | undefined;

  constructor(options: SlackConnectorOptions) {
    this.bindOperator = options.bindOperator;
    this.#identity = options.identity;
    if (options.defaultTarget !== undefined) this.defaultTarget = options.defaultTarget;
    this.#api = options.api;
    this.#knownAgents = new Set(options.knownAgents);
    this.#blobs = options.blobs;
    this.#now = options.now ?? Date.now;
    this.#pollIdleMs = options.pollIdleMs ?? 2000;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async start(onInbound: InboundHandler): Promise<void> {
    if (this.#loop !== undefined) throw new Error("slack connector already started");
    this.#loop = this.#run(onInbound);
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
  }

  async #run(onInbound: InboundHandler): Promise<void> {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      let incoming: readonly SlackIncoming[];
      try {
        const result = await this.#api.poll(this.#cursor, signal);
        incoming = result.incoming;
        if (result.cursor !== undefined) this.#cursor = result.cursor;
      } catch {
        if (signal.aborted) return;
        await this.#sleep(this.#pollIdleMs);
        continue;
      }
      for (const event of incoming) await this.#handle(event, onInbound);
      if (incoming.length === 0 && !signal.aborted) await this.#sleep(this.#pollIdleMs);
    }
  }

  async #handle(event: SlackIncoming, onInbound: InboundHandler): Promise<void> {
    // Users mode (§17.6): the sender is resolved through the channel bindings
    // BEFORE anything else; an unbound identity never reaches the router (§10.21).
    const identity = this.#identity;
    let from = this.bindOperator;
    let self = false;
    let target: string;
    if (identity !== undefined) {
      const sender =
        (event.sender?.handle !== undefined ? identity.userOf(event.sender.handle) : undefined) ??
        (event.sender?.userId !== undefined ? identity.userOf(event.sender.userId) : undefined);
      if (sender === undefined) {
        await this.#reply(
          "muxeon: this slack account is not linked to a MUXEON user — ask the operator to bind it",
        );
        return;
      }
      from = sender;
      const resolved = resolveUserTarget(event.text, sender, identity);
      target = resolved.target;
      self = resolved.self;
    } else {
      const resolved = resolveTarget(event.text, this.#knownAgents, this.defaultTarget);
      if (!resolved.ok) {
        await this.#reply(
          "muxeon: no recipient — address an agent with @name (no default target is set)",
        );
        return;
      }
      target = resolved.target;
    }
    if (from === undefined) return; // unreachable: legacy always binds an operator
    let payload: unknown;
    try {
      payload = await this.#buildPayload(event);
    } catch {
      await this.#reply("muxeon: failed to fetch the attached file");
      return;
    }
    if (payload === undefined) return;
    const message: Message = {
      id: `slack-${event.eventId}`, // deterministic per event → re-poll dedups (§10.9)
      from,
      to: target,
      kind: "message",
      ts: this.#now(),
      payload,
      origin: "slack",
    };
    try {
      await onInbound(message);
      // Self-delivery (§17.6-2c) is already visible in this channel — skip the echo.
      if (self) this.#suppressed.add(message.id);
    } catch (error) {
      await this.#reply(operatorErrorText(error)); // §3.2, redacted (§8.7)
    }
  }

  /**
   * Users-mode push (§17.5, FR-124): this connector talks to ONE slack channel, so
   * every bound user shares it — the record is posted there with its `from`
   * attribution. Best-effort: a throw is logged upstream, never re-queued.
   */
  async pushTo(_alias: string, signal: Signal): Promise<void> {
    if (this.#suppressed.delete(signal.id)) return;
    await this.deliver(signal);
  }

  /** Files → blob store FIRST (§5.4); the payload carries opaque refs only (§5.3). */
  async #buildPayload(event: SlackIncoming): Promise<unknown> {
    const files = event.files ?? [];
    if (files.length === 0) return event.text;
    const blobs: BlobRef[] = [];
    for (const file of files) {
      const id = await this.#blobs.write(await this.#api.download(file.id), { name: file.name });
      blobs.push({ blob: id, ...(file.name !== undefined ? { name: file.name } : {}) });
    }
    return { ...(event.text !== undefined ? { text: event.text } : {}), blobs };
  }

  async #reply(text: string): Promise<void> {
    try {
      await this.#api.sendText(text);
    } catch {
      // best-effort operator notice
    }
  }

  /** Egress sink (§8.4): text, then each blob as a file. Throw = re-send (§10.9). */
  async deliver(signal: Signal): Promise<void> {
    // Forward-compat kinds (FR-25b): reaction → small notice; unknown → ignore
    // (return, not throw — the egress completes it, §10.9).
    if (signal.kind === "reaction") {
      await this.#api.sendText(`[${signal.from}] reacted: ${reactionText(signal)}`);
      return;
    }
    if (signal.kind !== "message") return;
    const payload = normalizePayload(signal.payload);
    if (payload.text !== undefined) {
      await this.#api.sendText(`[${signal.from}] ${payload.text}`);
    }
    for (const ref of payload.blobs) {
      const bytes = await this.#blobs.read(ref.blob); // containment under blobs/ (§8.7)
      await this.#api.sendFile({ bytes, name: ref.name ?? ref.blob });
    }
  }
}
