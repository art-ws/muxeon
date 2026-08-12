// The router — the single delivery point (§8.2). EVERY producer (MCP send §8.1,
// channels §3.2, signals/routines §6) routes only through here: topology edge check
// (§10.2) → resolve the recipient name to its queue key → sanitize the id (§10.11)
// → queue.enqueue. Direct queue.enqueue past the router is impossible by import —
// @muxeon/queue is depended on only by @muxeon/orchestrator (§8, enforced by the
// architecture guard), and within it the router is the only caller of enqueue.

import { type Signal, type Topology, appendServer, isFqn, splitFqn } from "@muxeon/core";
import { enqueue, queueDepth, queuePaths, sanitizeFileId } from "@muxeon/queue";
import {
  DEFAULT_HOP_CAP,
  type FederationIngressResult,
  type FederationReceiptCode,
  type FederationReceiptPayload,
  type LinkRecord,
  type RouterFederation,
  fedQueueRoot,
} from "./federation";

export type RouteCode = "TOPOLOGY_DENIED" | "UNKNOWN_PEER" | "WIP_LIMIT" | "AGENT_PAUSED";

/** A fresh queue-filename stamp (§5.3): unix_ms + the process-wide seq. */
export interface QueueStamp {
  readonly unixMs: number;
  readonly seq: number;
}

/** One member's outcome in a broadcast fan-out (§15.4, FR-110). */
export interface FanoutEntry {
  readonly to: string;
  /** The per-member deterministic id `<bcastId>:<member>` (§10.9/§10.16). */
  readonly id: string;
  readonly ok: boolean;
  /** Set when `ok` is false — the per-member refusal (WIP_LIMIT / AGENT_PAUSED / UNKNOWN_PEER). */
  readonly code?: RouteCode;
}

export type RouteResult =
  | { readonly ok: true; readonly key: string; readonly filename: string }
  | {
      /**
       * Broadcast fan-out receipt (§15.4, §10.16): the `to` named a group/tag and was
       * expanded to one copy per resolved member. There is no single queue key — each
       * member's outcome is in `fanout`. Partial WIP refusals are per-member, never a
       * failure of the whole broadcast.
       */
      readonly ok: true;
      readonly kind: "broadcast";
      readonly target: string;
      readonly targetKind: "group" | "tag";
      readonly fanout: readonly FanoutEntry[];
    }
  | {
      readonly ok: false;
      readonly code: RouteCode;
      /** WIP_LIMIT only (FR-104): the recipient's limit and its depth at refusal — the receipt reason. */
      readonly limit?: number;
      readonly depth?: number;
    };

/** A resolved broadcast target — the group/tag kind and its member agent names (§15.4). */
export interface BroadcastResolution {
  readonly kind: "group" | "tag";
  readonly members: readonly string[];
}

export interface RouterOptions {
  readonly topology: Topology;
  /** Queue root <root> (§5.3). */
  readonly root: string;
  /**
   * Resolves a participant name to its queue key — an agent's tmux session name or
   * an operator's name (§5.3, §7.5) — or null if the name is not a known node.
   */
  readonly queueKeyOf: (name: string) => string | null;
  /**
   * WIP limit of a recipient (§8.2 backpressure, FR-104): the max un-drained
   * records (pending + cur) the router will admit for that recipient. `null` (or a
   * non-positive number) means EXEMPT — no cap, e.g. operators and the coordinator
   * hub, whose reachability must never be throttled. Absent option ⇒ every
   * recipient exempt (backward-compatible; tests that omit it are never gated).
   */
  readonly wipLimitOf?: (recipient: string) => number | null;
  /**
   * Is the recipient PAUSED (§16, FR-117)? A paused agent is admitted NOTHING: the
   * refusal is `AGENT_PAUSED`, before enqueue, for every kind — replies and the
   * system nudges included (`bypassWip` buys nothing here; it bypasses the WIP gate
   * only). Absent ⇒ nobody is paused (backward-compatible; tests that omit it are
   * never gated). Operators/groups/tags are never paused (§16.1) — the composition
   * root's predicate answers false for them.
   */
  readonly isPaused?: (recipient: string) => boolean;
  /**
   * Is the recipient a USER (§17.1)? Only used by the pause gate: a user's pause is
   * DND (§17.8, FR-134) — it protects them from OTHERS, not from their own notes, so
   * self-delivery (`from === to`) passes while paused. An agent's pause keeps the
   * §10.19 shape (nothing at all is admitted, self-delivery included). Absent ⇒ no
   * users configured; the gate behaves exactly as before.
   */
  readonly isUser?: (name: string) => boolean;
  /** Clock for the filename's unix_ms; injectable for tests. Default Date.now. */
  readonly now?: () => number;
  /**
   * Fired after every SUCCESSFUL route (§8.2) — the single delivery point sees all
   * sends, so this is where the reply-nudge ledger observes them (FR-45, T58).
   */
  readonly onRouted?: (message: Signal) => void;
  /**
   * Fired when a route is REFUSED (§8.2) — symmetric to {@link onRouted}. Carries the
   * refusal `code` (and, for `WIP_LIMIT`, the recipient's `limit`/`depth`). The
   * rendezvous coordinator (FR-105) hooks this to register a reconnection intent on a
   * `WIP_LIMIT` strike; other codes it ignores. Best-effort — never throws into route.
   */
  readonly onRefused?: (
    message: Signal,
    info: { readonly code: RouteCode; readonly limit?: number; readonly depth?: number },
  ) => void;
  /**
   * Classifies a `to` as a broadcast target (§15.4, FR-110): a group/tag resolves to
   * its member agent names; a normal agent/operator resolves to `null` (the
   * single-delivery path handles it). Absent ⇒ no groups/tags configured — every `to`
   * takes the single-delivery path (backward-compatible; tests that omit it never
   * fan out). The composition root builds it from `config.groups`/`config.agents`
   * (buildBroadcastResolver).
   */
  readonly resolveBroadcast?: (to: string) => BroadcastResolution | null;
  /**
   * Federation ports (§18.5, FR-141/FR-142): with them an FQN `to` routes into a
   * persistent link queue and inbound link envelopes pass the owner's gates HERE
   * (§10.26 — the router on both sides, a link cannot enqueue past it). Absent ⇒
   * no federation configured; an FQN `to` is UNKNOWN_PEER exactly as before (FR-146).
   */
  readonly federation?: RouterFederation;
}

/** Per-route overrides (§8.2). */
export interface RouteOptions {
  /**
   * Bypass the recipient's WIP gate (FR-104) for THIS route — allowed ONLY for a
   * `kind:"rendezvous"` system notice (FR-105). The double guard (flag AND kind) means
   * a caller cannot slip ordinary traffic past the gate, so §10.14 stays intact. A
   * bypassed route still respects topology (§10.2) and id sanitation (§10.11).
   */
  readonly bypassWip?: boolean;
}

export class Router {
  readonly #topology: Topology;
  readonly #root: string;
  readonly #queueKeyOf: (name: string) => string | null;
  readonly #wipLimitOf: ((recipient: string) => number | null) | undefined;
  readonly #isPaused: ((recipient: string) => boolean) | undefined;
  readonly #isUser: ((name: string) => boolean) | undefined;
  readonly #now: () => number;
  readonly #onRouted: ((message: Signal) => void) | undefined;
  readonly #onRefused:
    | ((
        message: Signal,
        info: { readonly code: RouteCode; readonly limit?: number; readonly depth?: number },
      ) => void)
    | undefined;
  readonly #resolveBroadcast: ((to: string) => BroadcastResolution | null) | undefined;
  readonly #federation: RouterFederation | undefined;
  // Global monotonic counter shared by all producers → total order of locally
  // produced messages (§5.3); one Router per server process.
  #seq = 0;

  constructor(options: RouterOptions) {
    this.#topology = options.topology;
    this.#root = options.root;
    this.#queueKeyOf = options.queueKeyOf;
    this.#wipLimitOf = options.wipLimitOf;
    this.#isPaused = options.isPaused;
    this.#isUser = options.isUser;
    this.#now = options.now ?? Date.now;
    this.#onRouted = options.onRouted;
    this.#onRefused = options.onRefused;
    this.#resolveBroadcast = options.resolveBroadcast;
    this.#federation = options.federation;
  }

  /**
   * A fresh filename stamp from the shared producer counter (§5.3) — used by
   * enqueue here and by requeue (§8.5), which regenerates `<unix_ms>-<seq>` so the
   * record joins the FIFO tail while keeping its logical id.
   */
  stamp(): QueueStamp {
    return { unixMs: this.#now(), seq: ++this.#seq };
  }

  /** Self-delivery of a PAUSED user (§17.8, FR-134) — the one pause-gate exception. */
  #dndSelfDelivery(message: Signal): boolean {
    return message.from === message.to && this.#isUser?.(message.to) === true;
  }

  /** Fire onRefused (best-effort, symmetric to onRouted) and return the refusal. */
  #refuse(message: Signal, result: RouteResult & { ok: false }): RouteResult {
    this.#onRefused?.(message, {
      code: result.code,
      ...(result.limit !== undefined ? { limit: result.limit } : {}),
      ...(result.depth !== undefined ? { depth: result.depth } : {}),
    });
    return result;
  }

  /**
   * Routes one message: UNKNOWN_PEER if `to` is not a node, TOPOLOGY_DENIED if there
   * is no edge (and it is not self-delivery, §10.2), AGENT_PAUSED if the operator
   * paused the recipient (§16.2, FR-117), WIP_LIMIT if the recipient's un-drained
   * depth already meets its WIP cap (§8.2 backpressure, FR-104), otherwise enqueues
   * it into the recipient's pending/. The recipient's queue directory must already
   * exist (the server creates every participant's queue at boot).
   * `options.bypassWip` skips the WIP gate for a `kind:"rendezvous"` system notice
   * only (FR-105) — it does NOT skip the pause gate.
   */
  async route(message: Signal, options?: RouteOptions): Promise<RouteResult> {
    // Federated egress (§18.5, FR-141): an FQN `to` resolves by its LAST `@` — the
    // tail must be a configured link — and lands in that link's persistent queue.
    // Checked before broadcast/queueKeyOf: `@` is banned in local names (§18.3), so
    // an FQN can never be a local participant. Without federation ports the name
    // simply falls through to UNKNOWN_PEER below (FR-146).
    if (this.#federation !== undefined && isFqn(message.to)) {
      return this.#routeFederatedEgress(message);
    }
    // Broadcast fan-out (§15.4, §10.16): a `to` naming a group/tag is expanded HERE,
    // in the single delivery point, into one copy per resolved member. This is checked
    // FIRST — a group/tag has no queue key, so queueKeyOf would otherwise reject it as
    // UNKNOWN_PEER. The private #fanout path keeps §10.2 in one place.
    const broadcast = this.#resolveBroadcast?.(message.to);
    if (broadcast !== null && broadcast !== undefined) return this.#fanout(message, broadcast);
    const key = this.#queueKeyOf(message.to);
    if (key === null) return this.#refuse(message, { ok: false, code: "UNKNOWN_PEER" });
    if (!this.#topology.canDeliver(message.from, message.to)) {
      return this.#refuse(message, { ok: false, code: "TOPOLOGY_DENIED" });
    }
    // Pause gate (§16.2, FR-117): an operator-declared refusal. Checked AFTER the
    // edge (a non-neighbour must not learn whether someone else's agent is paused —
    // observability is a right too, §8.7) and BEFORE the WIP gate (otherwise the
    // receipt would blame a queue that is un-drained precisely BECAUSE of the pause).
    // EVERY kind is refused — replies, the reply-nudge, the rendezvous notice (its
    // `bypassWip` buys nothing here), a raw turn and even self-delivery: pause is
    // about injection, not about rights. The payload is DROPPED (no pending/ record,
    // no done/ id — the same id re-sends fine after the resume) and the receipt
    // travels the producer's normal refusal path. No rendezvous is armed: the
    // coordinator only reacts to WIP_LIMIT (§16.2).
    // A user's pause is DND (§17.8, FR-134): the ONE deliberate asymmetry with the
    // agent gate above — a note to yourself still lands, because DND protects a
    // human from others, not from their own self-chat (§17.7).
    if (this.#isPaused?.(message.to) === true && !this.#dndSelfDelivery(message)) {
      return this.#refuse(message, { ok: false, code: "AGENT_PAUSED" });
    }
    // WIP limit (§8.2, FR-104): a gated recipient at or above its cap gets NOTHING
    // new admitted — EVERY kind, replies included (the operator chose the hardest
    // bound). The sender learns why from `limit`/`depth` (its NACK receipt). Exempt
    // recipients (operators, hub) return null here and are never gated. Soft bound:
    // two concurrent routes may both read depth = limit-1 and both admit, so a burst
    // can overshoot by the in-flight route count — acceptable, the flood still stops.
    // A rendezvous notice bypasses the gate (FR-105) — the double guard (flag AND
    // kind) keeps ordinary traffic gated, so §10.14 is untouched.
    const bypass = options?.bypassWip === true && message.kind === "rendezvous";
    const limit = bypass ? null : (this.#wipLimitOf?.(message.to) ?? null);
    if (limit !== null && limit > 0) {
      const depth = await queueDepth(queuePaths(this.#root, key));
      if (depth >= limit)
        return this.#refuse(message, { ok: false, code: "WIP_LIMIT", limit, depth });
    }
    // §10.11: the filename id is derived from a SANITIZED id so "/" or ".." cannot
    // move the rename outside pending/; the logical id (idempotency, §10.9) stays in
    // the body verbatim.
    const filename = await enqueue(queuePaths(this.#root, key), {
      ...this.stamp(),
      fileId: sanitizeFileId(message.id),
      message,
    });
    this.#onRouted?.(message); // reply-nudge ledger (FR-45) — after success only
    return { ok: true, key, filename };
  }

  /**
   * Broadcast fan-out (§15.4, §10.16): authorize ONCE against the group/tag node
   * (`from ↔ target` — per-member edges are NOT required), then deliver one
   * `kind:"broadcast"` copy to each resolved member, excluding the sender. Each copy
   * is independently WIP-gated (§10.14) and reported in `fanout`; a per-member refusal
   * never fails the whole broadcast. The addressed group/tag itself gets NO queue
   * record and is never a `from`.
   */
  async #fanout(message: Signal, target: BroadcastResolution): Promise<RouteResult> {
    if (!this.#topology.canDeliver(message.from, message.to)) {
      // One edge check against the group/tag node. No onRefused here — a broadcast is
      // one-directional and never registers rendezvous (§10.16).
      return { ok: false, code: "TOPOLOGY_DENIED" };
    }
    const fanout: FanoutEntry[] = [];
    for (const member of target.members) {
      if (member === message.from) continue; // self-exclusion (§15.4)
      // A fresh one-directional copy: deterministic id, broadcast origin, no replyTo /
      // raw carried over (a group/tag chat is outgoing-only). kind:"broadcast" keeps
      // the reply-nudge ledger from arming (nudge.ts arms only on "message").
      const copy: Signal = {
        id: `${message.id}:${member}`,
        from: message.from,
        to: member,
        kind: "broadcast",
        ts: message.ts,
        payload: message.payload,
        origin: `broadcast:${message.to}`,
      };
      fanout.push(await this.#deliverMember(copy));
    }
    return { ok: true, kind: "broadcast", target: message.to, targetKind: target.kind, fanout };
  }

  /**
   * Delivers ONE broadcast copy to a member (§15.4). No `from → member` topology
   * check — authorization happened once at the group/tag node (§10.16). The per-member
   * WIP gate (§10.14) still applies. On success `onRouted` fires so the transport log
   * sees each per-member delivery (§15.6 — how a group/tag resolved); a WIP/unknown
   * refusal is reported in the entry, and does NOT fire `onRefused` (no rendezvous
   * registration for a one-directional broadcast, §10.16).
   */
  async #deliverMember(copy: Signal): Promise<FanoutEntry> {
    const key = this.#queueKeyOf(copy.to);
    if (key === null) return { to: copy.to, id: copy.id, ok: false, code: "UNKNOWN_PEER" };
    // A paused member is refused its copy (§16.2) — per-member, like the WIP gate:
    // the rest of the fan-out is delivered, the pause shows up in `fanout[].code`.
    if (this.#isPaused?.(copy.to) === true) {
      return { to: copy.to, id: copy.id, ok: false, code: "AGENT_PAUSED" };
    }
    const limit = this.#wipLimitOf?.(copy.to) ?? null;
    if (limit !== null && limit > 0) {
      const depth = await queueDepth(queuePaths(this.#root, key));
      if (depth >= limit) return { to: copy.to, id: copy.id, ok: false, code: "WIP_LIMIT" };
    }
    await enqueue(queuePaths(this.#root, key), {
      ...this.stamp(),
      fileId: sanitizeFileId(copy.id),
      message: copy,
    });
    this.#onRouted?.(copy);
    return { to: copy.to, id: copy.id, ok: true };
  }

  /** Enqueue one record into a link's persistent queue (§18.5, store-and-forward). */
  async #enqueueLink(link: string, record: LinkRecord): Promise<string> {
    return enqueue(queuePaths(fedQueueRoot(this.#root), link), {
      ...this.stamp(),
      fileId: sanitizeFileId(record.id),
      message: record,
    });
  }

  /**
   * Federated egress (§18.5, FR-141): authorization is the sender's edge on the
   * link node (§18.10-6) — or, toward a link with no edge (typically an accept),
   * reply-correlation (§18.10-3): the send must answer a journaled exchange with
   * that FQN. No pause/WIP gates — a link queue is store-and-forward by design
   * (§10.25, the OWNER's gates run on the owning server at ingress). Only the
   * message/reply family crosses the boundary: system kinds (nudge/rendezvous/
   * broadcast) are refused here so they can never leave the server (§18.5, §10.24).
   */
  async #routeFederatedEgress(message: Signal): Promise<RouteResult> {
    const federation = this.#federation;
    if (federation === undefined) return this.#refuse(message, { ok: false, code: "UNKNOWN_PEER" });
    if (message.kind !== "message") {
      // The boundary denies the kind, not the address — a system notice aimed at an
      // FQN is a routing dead-end by design, not an unknown peer.
      return this.#refuse(message, { ok: false, code: "TOPOLOGY_DENIED" });
    }
    const parts = splitFqn(message.to);
    if (parts === null) return this.#refuse(message, { ok: false, code: "UNKNOWN_PEER" });
    if (federation.linkKind(parts.tail) === null) {
      return this.#refuse(message, { ok: false, code: "UNKNOWN_PEER" });
    }
    const edge = this.#topology.canDeliver(message.from, parts.tail);
    if (!edge && !(await federation.hasCorrelation(message.from, message.to, message.replyTo))) {
      return this.#refuse(message, { ok: false, code: "TOPOLOGY_DENIED" });
    }
    // The queue record keeps the local view (`to` = the full FQN); the wire frame is
    // derived from `fed` at the deliver port. `raw` never crosses the boundary (§18.5).
    const record: LinkRecord = {
      id: message.id,
      from: message.from,
      to: message.to,
      kind: message.kind,
      ts: message.ts,
      payload: message.payload,
      ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
      ...(message.origin !== undefined ? { origin: message.origin } : {}),
      fed: { to: parts.head, hops: 0 },
    };
    const filename = await this.#enqueueLink(parts.tail, record);
    this.#onRouted?.(message); // journal sees from → FQN; feeds reply-correlation back in
    return { ok: true, key: parts.tail, filename };
  }

  /**
   * Federated ingress (§18.5, FR-142; §10.26): every envelope and receipt a link
   * receives passes HERE. `from` gets the receiving link's suffix appended —
   * stamped by this side, never by the sender, so an FQN cannot be forged
   * (§10.24). An envelope resolves to a local exported actor (export-grant),
   * to a correlated non-exported actor (§18.10-3), or transits into the next
   * link's queue (hop-capped, FR-141); refusals travel back as receipts queued
   * on the SAME link (§10.25 — асинхронно, never lost silently). Local-owner
   * gates: pause §10.19 (DND included) and WIP §10.14. `onRefused` deliberately
   * does NOT fire: a rendezvous intent for a remote sender could never resolve
   * (the coordinator watches local idles only) — the receipt IS the refusal path.
   */
  async routeFederatedIngress(
    record: LinkRecord,
    linkName: string,
  ): Promise<FederationIngressResult> {
    const federation = this.#federation;
    if (federation === undefined) return { ok: false, code: "UNKNOWN_ACTOR" };
    const stampedFrom = appendServer(record.from, linkName);
    if (record.fed.receipt !== undefined) {
      return this.#ingressReceipt(record, record.fed.receipt, stampedFrom, linkName, federation);
    }
    const hopCap = federation.hopCap ?? DEFAULT_HOP_CAP;
    const head = record.fed.to;
    const refuse = async (
      code: FederationReceiptCode,
      detail?: string,
    ): Promise<FederationIngressResult> => {
      await this.#enqueueLink(linkName, {
        id: `${record.id}:receipt`,
        from: head,
        to: stampedFrom,
        kind: "message",
        ts: this.#now(),
        payload: null,
        fed: {
          to: record.from,
          hops: 0,
          receipt: { ref: record.id, code, ...(detail !== undefined ? { detail } : {}) },
        },
      });
      return { ok: false, code };
    };
    // System kinds never cross the boundary (§18.5/§10.24) — an authenticated link
    // still cannot inject a nudge/rendezvous/broadcast into this server.
    if (record.kind !== "message") return refuse("UNKNOWN_ACTOR");
    if (isFqn(head)) {
      // Transit (§18.5, FR-141): forward the head into the next link's queue. No
      // local topology is consulted — authorization happened at the origin and the
      // owner's gates run at the destination (§10.26); this hop only counts.
      if (record.fed.hops + 1 > hopCap) return refuse("HOP_CAP", `hop cap ${hopCap} exceeded`);
      const next = splitFqn(head);
      if (next === null) return refuse("UNKNOWN_ACTOR");
      const kind = federation.linkKind(next.tail);
      if (kind === null) return refuse("UNKNOWN_ACTOR");
      // Toward an import the hop must be re-exported (§18.2 transit); toward an
      // accept it is a reply path and always open — answers flow back (§18.10-3).
      if (kind === "import" && !federation.transitAllowed(next.tail)) {
        return refuse("UNKNOWN_ACTOR");
      }
      await this.#enqueueLink(next.tail, {
        ...record,
        from: stampedFrom,
        to: head,
        fed: { to: next.head, hops: record.fed.hops + 1 },
      });
      // No onRouted: a transit record is not this server's exchange — the journal
      // (and the reply-correlation built on it) tracks only local endpoints.
      return { ok: true };
    }
    // Local delivery: the export-grant IS the authorization (§18.10-2) — exported ⇒
    // reachable to any authenticated importer. A non-exported actor is reachable
    // only through reply-correlation (§18.10-3) and otherwise does not exist
    // (UNKNOWN_ACTOR — never a hint that the name is real, §10.24).
    const local = federation.exportedToLocal(head);
    let recipient = local;
    if (recipient === null) {
      const candidate = this.#queueKeyOf(head) !== null ? head : null;
      if (
        candidate === null ||
        !(await federation.hasCorrelation(candidate, stampedFrom, record.replyTo))
      ) {
        return refuse("UNKNOWN_ACTOR");
      }
      recipient = candidate;
    }
    const key = this.#queueKeyOf(recipient);
    if (key === null) return refuse("UNKNOWN_ACTOR");
    if (this.#isPaused?.(recipient) === true) return refuse("AGENT_PAUSED");
    const limit = this.#wipLimitOf?.(recipient) ?? null;
    if (limit !== null && limit > 0) {
      const depth = await queueDepth(queuePaths(this.#root, key));
      if (depth >= limit) return refuse("WIP_LIMIT", `limit ${limit}, depth ${depth}`);
    }
    const delivered: Signal = {
      id: record.id,
      from: stampedFrom,
      to: recipient,
      kind: record.kind,
      ts: record.ts,
      payload: record.payload,
      ...(record.replyTo !== undefined ? { replyTo: record.replyTo } : {}),
      origin: `fed:${linkName}`,
    };
    await enqueue(queuePaths(this.#root, key), {
      ...this.stamp(),
      fileId: sanitizeFileId(delivered.id),
      message: delivered,
    });
    // The journal records the local endpoint's view (from = the stamped FQN) — this
    // is what authorizes the actor's replies back through the link (§18.10-3).
    this.#onRouted?.(delivered);
    await this.#enqueueLink(linkName, {
      id: `${record.id}:receipt`,
      from: head,
      to: stampedFrom,
      kind: "message",
      ts: this.#now(),
      payload: null,
      fed: { to: record.from, hops: 0, receipt: { ref: record.id, code: "ok" } },
    });
    return { ok: true };
  }

  /**
   * A receipt arriving over a link (§18.5, FR-143): transit back hop by hop
   * (`fed.to` strips one tail per hop, exactly like envelopes), or — at the
   * origin — notify the local sender through its queue: a failure becomes a
   * `[federation]` notice in the pair's own chat (replyTo = the refused id),
   * an `ok` is silent. Receipts never generate receipts, so the chain always
   * terminates; a hop overrun is dropped, not looped.
   */
  async #ingressReceipt(
    record: LinkRecord,
    receipt: FederationReceiptPayload,
    stampedFrom: string,
    linkName: string,
    federation: RouterFederation,
  ): Promise<FederationIngressResult> {
    const head = record.fed.to;
    const hopCap = federation.hopCap ?? DEFAULT_HOP_CAP;
    if (isFqn(head)) {
      if (record.fed.hops + 1 > hopCap) return { ok: false, code: "HOP_CAP" };
      const next = splitFqn(head);
      if (next === null || federation.linkKind(next.tail) === null) {
        return { ok: false, code: "UNKNOWN_ACTOR" };
      }
      await this.#enqueueLink(next.tail, {
        ...record,
        from: stampedFrom,
        to: head,
        fed: { to: next.head, hops: record.fed.hops + 1, receipt },
      });
      return { ok: true };
    }
    const key = this.#queueKeyOf(head);
    if (key === null) return { ok: false, code: "UNKNOWN_ACTOR" };
    if (receipt.code === "ok") return { ok: true }; // delivered — nothing to say
    const notice: Signal = {
      id: `${receipt.ref}:fed-receipt`,
      from: stampedFrom,
      to: head,
      kind: "message",
      ts: this.#now(),
      payload: `[federation] not delivered: ${receipt.code}${
        receipt.detail !== undefined ? ` (${receipt.detail})` : ""
      }`,
      replyTo: receipt.ref,
      origin: `fed:${linkName}`,
    };
    // Straight into the sender's queue: the FR-104 refusal tail of an ALREADY
    // authorized egress — no edge re-check (the remote `from` is not a node), no
    // WIP (a receipt must not be lost, §10.25), no pause drop (the dispatcher
    // holds a paused agent anyway; a DND user still owns their send's outcome).
    await enqueue(queuePaths(this.#root, key), {
      ...this.stamp(),
      fileId: sanitizeFileId(notice.id),
      message: notice,
    });
    this.#onRouted?.(notice);
    return { ok: true };
  }
}
