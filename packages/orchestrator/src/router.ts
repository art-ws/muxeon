// The router — the single delivery point (§8.2). EVERY producer (MCP send §8.1,
// channels §3.2, signals/routines §6) routes only through here: topology edge check
// (§10.2) → resolve the recipient name to its queue key → sanitize the id (§10.11)
// → queue.enqueue. Direct queue.enqueue past the router is impossible by import —
// @teamai/queue is depended on only by @teamai/orchestrator (§8, enforced by the
// architecture guard), and within it the router is the only caller of enqueue.

import type { Signal, Topology } from "@teamai/core";
import { enqueue, queueDepth, queuePaths, sanitizeFileId } from "@teamai/queue";

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
}
