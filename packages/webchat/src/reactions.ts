// Reactions (§19, FR-161…FR-168): a mark ON an existing message instead of a new
// message. Three properties shape the whole module:
//
//   1. A reaction is NOT a message. It has no envelope in the history (§5.3), no
//      place in a queue (§10.1), no delivery lifecycle. It is an EVENT over a
//      record, and the only thing it can put in a queue is one notification to the
//      agent whose message was marked (§19.6, invariant §10.30).
//   2. It is asymmetric. To a human an incoming reaction is a NOTICE; to an agent
//      it is potentially an INSTRUCTION whose text the operator wrote (§19.1) —
//      "🔁" can mean "redo the result of that message and say what changed".
//   3. The palette is CLOSED by the config catalog (§19.2): an undeclared emoji has
//      no agent text, no category and no meaningful place in Recent.
//
// Storage lives BESIDE the history, never inside it (§19.4):
//
//   <config_dir>/webchat/reactions/<owner>/<peer>.jsonl   — append-only events
//   <config_dir>/webchat/reactions-usage.json             — global frequency counters
//
// Why a sidecar: the pair log is read as a stream of ENVELOPES (previews, unread,
// backward cursors, dedup, export). A foreign record shape would force every one of
// those readers to filter, and "the pair is the only writer of envelopes" (§17.7)
// would stop being literally true.

import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { type HistoryStore, encodePeerName } from "./history";

/** One picker block (§19.2) — structural twin of the config's category. */
export interface ReactionCatalogCategory {
  readonly name: string;
  readonly title?: string;
}

/**
 * One declared reaction (§19.2). Declared here rather than imported so webchat
 * stays free of a config dependency (§8 layering) — the server adapts its config.
 */
export interface ReactionCatalogItem {
  readonly key: string;
  readonly emoji: string;
  readonly label?: string;
  readonly category?: string;
  /** Verbatim operator text delivered to an agent whose message was marked (§19.6). */
  readonly agentMessage?: string;
  /** Opt-in to a real turn with a reply contract (§19.6); default: a notice. */
  readonly expectsReply?: boolean;
}

export interface ReactionCatalog {
  readonly categories: readonly ReactionCatalogCategory[];
  readonly items: readonly ReactionCatalogItem[];
  /** Length of the frequency-ordered Recent block (§19.8); 0 hides it. */
  readonly recentLimit: number;
}

/** An append-only sidecar line (§19.4). `emoji` is snapshotted at add time. */
interface ReactionEvent {
  readonly op: "add" | "remove";
  readonly message: string;
  readonly actor: string;
  readonly key: string;
  readonly emoji?: string;
  readonly ts: number;
}

/** Who placed one reaction, and when (§19.9 — the badge popup's list). */
export interface ReactionActor {
  readonly name: string;
  readonly ts: number;
}

/** The folded state of one reaction key on one message (§19.5). */
export interface ReactionView {
  readonly key: string;
  /** Snapshot from the placement — a key dropped from the config still renders (§19.4). */
  readonly emoji: string;
  readonly count: number;
  readonly actors: readonly ReactionActor[];
  /** Did the VIEWER place this one? Drives the accent ring and the remove item. */
  readonly mine: boolean;
}

/** Reactions of several messages at once — the shape a history page carries (§19.5). */
export type ReactionMap = Record<string, ReactionView[]>;

export interface ReactionStoreOptions {
  /** Per-owner sidecar dir: <config_dir>/webchat/reactions/<owner>. */
  readonly dir: string;
  readonly now?: () => number;
}

interface PeerEvents {
  events: ReactionEvent[];
}

/**
 * The per-owner reaction sidecar (§19.4). One file per pair, appended in order,
 * folded on read; the same crash-safety idiom as the history (a torn tail is
 * dropped, unparsable lines are skipped, operations are serialized).
 */
export class ReactionStore {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #peers = new Map<string, PeerEvents>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: ReactionStoreOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Place one reaction. Resolves false when the triple (message, actor, key) is
   * already there — an idempotent repeat writes nothing, counts nothing and
   * notifies nobody (§19.4): a double click must not become two injections.
   */
  add(peer: string, message: string, actor: string, key: string, emoji: string): Promise<boolean> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      if (fold(cache.events).get(message)?.get(pairKey(actor, key)) !== undefined) return false;
      await this.#append(peer, cache, {
        op: "add",
        message,
        actor,
        key,
        emoji,
        ts: this.#now(),
      });
      return true;
    });
  }

  /** Remove the actor's OWN reaction; false when it was not there (idempotent). */
  remove(peer: string, message: string, actor: string, key: string): Promise<boolean> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      if (fold(cache.events).get(message)?.get(pairKey(actor, key)) === undefined) return false;
      await this.#append(peer, cache, { op: "remove", message, actor, key, ts: this.#now() });
      return true;
    });
  }

  /** The folded reactions of ONE message, as the viewer sees them (§19.5). */
  of(peer: string, message: string, viewer: string): Promise<ReactionView[]> {
    return this.#serialize(async () =>
      views(fold((await this.#load(peer)).events).get(message), viewer),
    );
  }

  /** Reactions of the ids on ONE page (§19.5) — absent ids simply do not appear. */
  map(peer: string, ids: readonly string[], viewer: string): Promise<ReactionMap> {
    return this.#serialize(async () => {
      if (ids.length === 0) return {};
      const folded = fold((await this.#load(peer)).events);
      return project(folded, ids, viewer);
    });
  }

  /**
   * Reactions of ids that may come from ANY pair — the self-chat projection
   * (§17.7/§19.4), whose thread is merged across every pair log. The sidecars are
   * small, so the merge is a scan; the key of the map is the record id, which makes
   * the merge itself trivial.
   */
  mapAll(ids: readonly string[], viewer: string): Promise<ReactionMap> {
    return this.#serialize(async () => {
      if (ids.length === 0) return {};
      const merged = new Map<string, Map<string, { emoji: string; ts: number }>>();
      for (const peer of await this.#listPeers()) {
        for (const [message, entries] of fold((await this.#load(peer)).events)) {
          const into = merged.get(message) ?? new Map();
          for (const [pair, value] of entries) into.set(pair, value);
          merged.set(message, into);
        }
      }
      return project(merged, ids, viewer);
    });
  }

  /** Drop the pair's sidecar — the history `clear` path (FR-84, §19.4). */
  clear(peer: string): Promise<void> {
    return this.#serialize(async () => {
      this.#peers.set(peer, { events: [] });
      try {
        await unlink(this.#file(peer));
      } catch {
        // never existed
      }
    });
  }

  /**
   * Compaction (§19.4): keep only events of messages that are still in the pair's
   * log, and only the SURVIVING state — removals collapse away instead of
   * accumulating. Runs on the retention sweep, beside the history's own caps.
   */
  compact(peer: string, liveIds: ReadonlySet<string>): Promise<void> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const folded = fold(cache.events);
      const kept: ReactionEvent[] = [];
      for (const [message, entries] of folded) {
        if (!liveIds.has(message)) continue;
        for (const [pair, value] of entries) {
          const { actor, key } = splitPairKey(pair);
          kept.push({ op: "add", message, actor, key, emoji: value.emoji, ts: value.ts });
        }
      }
      if (kept.length === cache.events.length) return; // nothing to gain
      cache.events = kept;
      await this.#rewrite(peer, cache);
    });
  }

  /** Pairs that have a sidecar — the compaction sweep's worklist. */
  peers(): Promise<string[]> {
    return this.#serialize(() => this.#listPeers());
  }

  // --- internals -------------------------------------------------------------

  #serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(op, op);
    this.#chain = next.catch(() => undefined); // one failure must not poison the chain
    return next;
  }

  #file(peer: string): string {
    return join(this.#dir, `${encodePeerName(peer)}.jsonl`);
  }

  async #listPeers(): Promise<string[]> {
    try {
      return (await readdir(this.#dir))
        .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
        .map((name) => decodePeerName(name.slice(0, -".jsonl".length)))
        .sort();
    } catch {
      return []; // no reactions yet
    }
  }

  async #append(peer: string, cache: PeerEvents, event: ReactionEvent): Promise<void> {
    cache.events.push(event);
    await mkdir(this.#dir, { recursive: true });
    await appendFile(this.#file(peer), `${JSON.stringify(event)}\n`, "utf8");
  }

  async #rewrite(peer: string, cache: PeerEvents): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    if (cache.events.length === 0) {
      try {
        await unlink(this.#file(peer));
      } catch {
        // never existed
      }
      return;
    }
    const tmp = join(this.#dir, `.tmp-${encodePeerName(peer)}.jsonl`);
    const body = cache.events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(tmp, `${body}\n`, "utf8");
    await rename(tmp, this.#file(peer)); // atomic (§5.3), same dir ⇒ same FS
  }

  async #load(peer: string): Promise<PeerEvents> {
    const cached = this.#peers.get(peer);
    if (cached !== undefined) return cached;
    const cache: PeerEvents = { events: [] };
    let raw: string;
    try {
      raw = await readFile(this.#file(peer), "utf8");
    } catch {
      this.#peers.set(peer, cache);
      return cache;
    }
    // A complete file ends with "\n"; a non-empty final chunk is a crash-torn tail
    // and is dropped — the §12.3 read rule, applied to the sidecar.
    const lines = raw.split("\n");
    for (const line of lines.slice(0, -1)) {
      if (line === "") continue;
      let event: ReactionEvent;
      try {
        event = JSON.parse(line) as ReactionEvent;
      } catch {
        continue; // one corrupt line must not take the pair's reactions down
      }
      if (
        (event.op !== "add" && event.op !== "remove") ||
        typeof event.message !== "string" ||
        typeof event.actor !== "string" ||
        typeof event.key !== "string" ||
        typeof event.ts !== "number"
      ) {
        continue;
      }
      cache.events.push(event);
    }
    this.#peers.set(peer, cache);
    return cache;
  }
}

// --- folding ----------------------------------------------------------------

type Folded = Map<string, Map<string, { emoji: string; ts: number }>>;

/**
 * Events → state, last-writer-wins per (message, actor, key) in file order:
 * `add` sets, `remove` deletes. Insertion order of the map is the order the panel
 * shows keys in — first appearance, so badges do not jump around on removals.
 */
function fold(events: readonly ReactionEvent[]): Folded {
  const state: Folded = new Map();
  for (const event of events) {
    const entries = state.get(event.message) ?? new Map<string, { emoji: string; ts: number }>();
    const pair = pairKey(event.actor, event.key);
    if (event.op === "add") {
      entries.set(pair, { emoji: event.emoji ?? "", ts: event.ts });
    } else {
      entries.delete(pair);
    }
    if (entries.size === 0) state.delete(event.message);
    else state.set(event.message, entries);
  }
  return state;
}

function project(folded: Folded, ids: readonly string[], viewer: string): ReactionMap {
  const out: ReactionMap = {};
  for (const id of ids) {
    const entries = folded.get(id);
    if (entries === undefined || entries.size === 0) continue;
    out[id] = views(entries, viewer);
  }
  return out;
}

/** One message's entries → the per-key views, keys in first-appearance order. */
function views(
  entries: Map<string, { emoji: string; ts: number }> | undefined,
  viewer: string,
): ReactionView[] {
  if (entries === undefined) return [];
  const byKey = new Map<string, { emoji: string; actors: ReactionActor[]; mine: boolean }>();
  for (const [pair, value] of entries) {
    const { actor, key } = splitPairKey(pair);
    const view = byKey.get(key) ?? { emoji: value.emoji, actors: [], mine: false };
    view.actors.push({ name: actor, ts: value.ts });
    if (actor === viewer) view.mine = true;
    if (view.emoji === "" && value.emoji !== "") view.emoji = value.emoji;
    byKey.set(key, view);
  }
  return [...byKey].map(([key, view]) => ({
    key,
    emoji: view.emoji,
    count: view.actors.length,
    actors: view.actors.sort((a, b) => a.ts - b.ts),
    mine: view.mine,
  }));
}

// Actor names and reaction keys are config-validated strings; NUL cannot occur in
// either, so it is a safe composite separator (the same trick the login
// rate-limiter uses for its (user, IP) key).
const PAIR_SEPARATOR = "\u0000";

function pairKey(actor: string, key: string): string {
  return `${actor}${PAIR_SEPARATOR}${key}`;
}

function splitPairKey(pair: string): { actor: string; key: string } {
  const at = pair.indexOf(PAIR_SEPARATOR);
  return { actor: pair.slice(0, at), key: pair.slice(at + PAIR_SEPARATOR.length) };
}

function decodePeerName(encoded: string): string {
  return encoded.replace(/%([0-9a-f]+)%/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

// --- usage counters ---------------------------------------------------------

export interface ReactionUsageOptions {
  /** Absolute path of the counter file (§19.8): <config_dir>/webchat/reactions-usage.json. */
  readonly file: string;
  /** Coalescing window for the atomic rewrite; default 1s (§19.8). */
  readonly flushMs?: number;
  readonly now?: () => number;
}

interface UsageEntry {
  count: number;
  last: number;
}

/**
 * Global reaction frequency (§19.8, FR-166): every user AND agent counts into the
 * same jar, because the Recent block is "what this stand uses", not "what I use".
 *
 * Two deliberate asymmetries: a removal does NOT decrement (it is a usage counter,
 * not a census of live badges — otherwise one actor could zero out everyone else's
 * ordering), and a key that leaves the catalog keeps its count (flipping the config
 * back must not erase what was learned).
 */
export class ReactionUsage {
  readonly #file: string;
  readonly #flushMs: number;
  readonly #now: () => number;
  readonly #counts = new Map<string, UsageEntry>();
  #loaded = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: ReactionUsageOptions) {
    this.#file = options.file;
    this.#flushMs = options.flushMs ?? 1000;
    this.#now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.#file, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== "object" || value === null) continue;
        const { count, last } = value as { count?: unknown; last?: unknown };
        if (typeof count !== "number" || !Number.isFinite(count)) continue;
        this.#counts.set(key, { count, last: typeof last === "number" ? last : 0 });
      }
    } catch {
      // no counters yet (or a torn write) — Recent starts from the catalog order
    }
  }

  /** Count one PLACEMENT. Persisted on a coalescing timer, never synchronously. */
  bump(key: string): void {
    const entry = this.#counts.get(key) ?? { count: 0, last: 0 };
    entry.count += 1;
    entry.last = this.#now();
    this.#counts.set(key, entry);
    this.#schedule();
  }

  /**
   * The Recent order (§19.8): count desc → most recent use → catalog order, capped
   * at `limit`. Keys absent from the catalog are dropped from the OUTPUT (their
   * counters stay), so an edited config never shows a reaction nobody can place.
   */
  order(catalogKeys: readonly string[], limit: number): string[] {
    if (limit <= 0) return [];
    const known = catalogKeys.map((key, index) => ({
      key,
      index,
      entry: this.#counts.get(key),
    }));
    return known
      .filter((row) => (row.entry?.count ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.entry?.count ?? 0) - (a.entry?.count ?? 0) ||
          (b.entry?.last ?? 0) - (a.entry?.last ?? 0) ||
          a.index - b.index,
      )
      .slice(0, limit)
      .map((row) => row.key);
  }

  /** Write the counters out now (shutdown / tests). */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#write();
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#write();
    }, this.#flushMs);
    // A pending counter flush must never hold the process open (NFR-4: the numbers
    // only order a picker; losing the last second of them costs nothing).
    this.#timer.unref?.();
  }

  #write(): Promise<void> {
    const body = JSON.stringify(Object.fromEntries(this.#counts));
    this.#writing = this.#writing.then(async () => {
      const dir = this.#file.slice(0, this.#file.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, `${body}\n`, "utf8");
      await rename(tmp, this.#file);
    });
    return this.#writing.catch(() => undefined);
  }
}

// --- the hub ----------------------------------------------------------------

/** WS push shape (§19.5): the folded state of one message after a change. */
export interface ReactionPush {
  readonly peer: string;
  readonly messageId: string;
  readonly reactions: readonly ReactionView[];
}

/** What became of the notification to an agent (§19.6) — never silently lost. */
export interface NotifyOutcome {
  readonly delivered: boolean;
  readonly code?: string;
}

export type ReactionFailure =
  | "REACTIONS_DISABLED"
  | "UNKNOWN_REACTION"
  | "UNKNOWN_MESSAGE"
  | "NOT_REACTABLE"
  | "REACTION_DENIED";

export type ReactionOutcome =
  | {
      readonly ok: true;
      readonly reactions: readonly ReactionView[];
      /** Present only when a notification was actually attempted (§19.6). */
      readonly notify?: NotifyOutcome;
    }
  | { readonly ok: false; readonly code: ReactionFailure; readonly message: string };

/** Per-owner state the hub needs: the pair's two files (§19.4). */
export interface ReactionOwner {
  readonly history: HistoryStore;
  readonly reactions: ReactionStore;
}

/**
 * The agent↔agent carrier (§19.13, FR-181). Such a pair keeps no panel history —
 * which is why §19.10 excluded it — but it does have a record: the router is the
 * single delivery point, so the transport journal (FR-48) holds every signal
 * between the two, with its id. That journal answers "is there a message to mark",
 * and the sidecar lives under its own root, ONE file per pair (both ends see each
 * other, so there is nothing to mirror and nothing to keep isolated).
 *
 * Absent ⇒ an agent peer stays NOT_REACTABLE, exactly as before FR-181.
 */
export interface AgentPairs {
  /** The pair's sidecar and the key that addresses it (canonical order inside). */
  pair(a: string, b: string): { store: ReactionStore; key: string };
  /** The marked record, if the journal still holds it on this pair. */
  record(a: string, b: string, id: string): Promise<Signal | undefined>;
}

export interface ReactionsHubOptions {
  readonly catalog: ReactionCatalog;
  /** Resolves an owner's history + sidecar; undefined ⇒ that name has no chat. */
  ownerOf(owner: string): ReactionOwner | undefined;
  /** The agent↔agent carrier (§19.13); absent ⇒ agent peers stay NOT_REACTABLE. */
  readonly agentPairs?: AgentPairs;
  readonly usage: ReactionUsage;
  /** Is this participant a local AGENT (a turn taker)? Drives the notification (§19.6). */
  isAgent(name: string): boolean;
  /** router.route — the notification's only path (§8.2); absent ⇒ no notifications. */
  route?(signal: Signal): Promise<{ readonly ok: boolean; readonly code?: string }>;
  /** Push the folded state to one identity's tabs (§19.5). */
  push?(owner: string, event: ReactionPush): void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * The one place a reaction is placed or removed (§19.5/§19.7) — the panel and the
 * agent-plane `react` tool are two doors into THIS method, so both obey the same
 * idempotency, the same mirroring and the same notification rules.
 */
export class ReactionsHub {
  readonly #options: ReactionsHubOptions;
  readonly #now: () => number;
  #push: ((owner: string, event: ReactionPush) => void) | undefined;
  #journalPush: ((event: ReactionPush) => void) | undefined;

  constructor(options: ReactionsHubOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#push = options.push;
  }

  /**
   * The panel registers its socket push here (§19.6) — the hub is built by the
   * composition root (the `react` tool needs it too) and learns about browsers only
   * when a connector exists. Last registration wins; absent ⇒ no live updates, and
   * the badge simply appears when the chat is next opened.
   */
  registerPush(push: (owner: string, event: ReactionPush) => void): void {
    this.#push = push;
  }

  /**
   * The panel's JOURNAL push (§19.13/FR-182): an agent↔agent pair has no owner
   * with tabs, and the operator sees that traffic only in the transport journal —
   * so a receipt they cannot see did not happen for them. Read-only by
   * construction: this is a push OUT, and no journal surface places anything.
   */
  registerJournalPush(push: (event: ReactionPush) => void): void {
    this.#journalPush = push;
  }

  /**
   * The folded reactions of journal RECORDS (FR-182) — agent↔agent pairs only.
   * A user's pair is deliberately skipped: those reactions belong to that user's
   * chat (§10.31), and the journal is not a place to enumerate them from.
   */
  async journalMap(records: readonly Signal[]): Promise<ReactionMap> {
    const pairs = this.#options.agentPairs;
    if (!this.enabled || pairs === undefined) return {};
    // Group by pair first: one sidecar read per pair, not one per record.
    const byPair = new Map<string, { a: string; b: string; ids: string[] }>();
    for (const record of records) {
      const { from, to } = record;
      if (!this.#options.isAgent(from) || !this.#options.isAgent(to)) continue;
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const group = byPair.get(`${lo}\u0000${hi}`) ?? { a: lo, b: hi, ids: [] };
      group.ids.push(record.id);
      byPair.set(`${lo}\u0000${hi}`, group);
    }
    const map: ReactionMap = {};
    for (const { a, b, ids } of byPair.values()) {
      const { store, key } = pairs.pair(a, b);
      // The viewer is nobody: the journal shows what was placed, never "mine" —
      // the operator does not react there (decision Q1).
      Object.assign(map, await store.map(key, ids, ""));
    }
    return map;
  }

  get enabled(): boolean {
    return this.#options.catalog.items.length > 0;
  }

  /** The catalog plus the current Recent order (§19.5/§19.8). */
  catalog(): {
    categories: readonly ReactionCatalogCategory[];
    items: readonly ReactionCatalogItem[];
    recent: readonly string[];
  } {
    const { categories, items, recentLimit } = this.#options.catalog;
    return {
      categories,
      items,
      recent: this.#options.usage.order(
        items.map((item) => item.key),
        recentLimit,
      ),
    };
  }

  /** The folded reactions of a history page (§19.5): `{}` when the feature is off. */
  async pageMap(
    owner: string,
    peer: string,
    ids: readonly string[],
    options: { readonly merged?: boolean } = {},
  ): Promise<ReactionMap> {
    const state = this.#options.ownerOf(owner);
    if (!this.enabled || state === undefined) return {};
    return options.merged === true
      ? state.reactions.mapAll(ids, owner)
      : state.reactions.map(peer, ids, owner);
  }

  /** Drop a pair's reactions together with its log (FR-84). */
  async clear(owner: string, peer: string): Promise<void> {
    await this.#options.ownerOf(owner)?.reactions.clear(peer);
  }

  /**
   * Place or remove one reaction (§19.5/§19.7).
   *
   * `owner` — whose history dir holds the pair; `peer` — the other side; `actor` —
   * who reacts. The panel calls it with owner = actor = the logged-in user; the
   * `react` tool with owner = the user peer, peer = actor = the calling agent. That
   * asymmetry is the whole point: the pair is always (owner, peer), so a caller can
   * never mark a message in a pair it is not part of.
   */
  async react(input: {
    readonly owner: string;
    readonly peer: string;
    readonly messageId: string;
    readonly actor: string;
    readonly key: string;
    readonly remove?: boolean;
  }): Promise<ReactionOutcome> {
    const { owner, peer, messageId, actor, key } = input;
    if (!this.enabled) {
      return {
        ok: false,
        code: "REACTIONS_DISABLED",
        message: "no reaction catalog is configured",
      };
    }
    const item = this.#options.catalog.items.find((entry) => entry.key === key);
    if (item === undefined) {
      return { ok: false, code: "UNKNOWN_REACTION", message: `unknown reaction "${key}"` };
    }
    // Two AGENTS (§19.13, FR-181): no panel history, so the carrier is the
    // transport journal and the sidecar is the pair's own. Everything else — the
    // catalog, idempotency, the counters, the deterministic notification id — is
    // shared with the path below, which is the point of having one hub.
    if (this.#options.isAgent(owner) && this.#options.isAgent(peer)) {
      return await this.#reactBetweenAgents(input, item);
    }
    const state = this.#options.ownerOf(owner);
    if (state === undefined) {
      return {
        ok: false,
        code: "NOT_REACTABLE",
        message: `"${owner}" has no chat history to react in`,
      };
    }
    const record = await findRecord(state.history, peer, messageId);
    if (record === undefined) {
      return {
        ok: false,
        code: "UNKNOWN_MESSAGE",
        message: `no message "${messageId}" in the chat with "${peer}"`,
      };
    }

    if (input.remove === true) {
      // Only the author of a reaction removes it (§10.31) — admins included. The
      // store is keyed by (message, actor, key), so "someone else's" is not a check
      // that can be forgotten: it is a different key.
      const changed = await state.reactions.remove(peer, messageId, actor, key);
      const mirrored = await this.#mirror(owner, peer, messageId, actor, key, undefined);
      const reactions = await state.reactions.of(peer, messageId, owner);
      if (changed || mirrored) this.#broadcast(owner, peer, messageId, reactions);
      return { ok: true, reactions };
    }

    const placed = await state.reactions.add(peer, messageId, actor, key, item.emoji);
    await this.#mirror(owner, peer, messageId, actor, key, item.emoji);
    const reactions = await state.reactions.of(peer, messageId, owner);
    if (!placed) return { ok: true, reactions }; // idempotent repeat: no count, no notice
    this.#options.usage.bump(key);
    this.#broadcast(owner, peer, messageId, reactions);
    const notify = await this.#notify(record, actor, item, messageId);
    return { ok: true, reactions, ...(notify !== undefined ? { notify } : {}) };
  }

  /**
   * A reaction inside an agent↔agent pair (§19.13, FR-181). The shape mirrors the
   * panel path deliberately; the three differences are all consequences of "no
   * panel history, two turn-takers":
   *
   *   - the carrier is the transport journal, so an id it no longer holds is
   *     UNKNOWN_MESSAGE (a reaction is a gesture on a live conversation);
   *   - one sidecar for the pair, no mirroring and no socket push (neither end
   *     has tabs — the injected notice IS how the other agent sees it);
   *   - the notification is ALWAYS a notice: `expectsReply` of the catalog item is
   *     ignored here (decision Q3). The instructive keys are written in the
   *     operator's voice — their texts literally begin "Оператор…" — and a gesture
   *     that sends a peer back to redo work would reinstate the very ack loop
   *     §13.7 exists to end. Want work done? Send a message and pay a turn for it.
   */
  async #reactBetweenAgents(
    input: {
      readonly owner: string;
      readonly peer: string;
      readonly messageId: string;
      readonly actor: string;
      readonly key: string;
      readonly remove?: boolean;
    },
    item: ReactionCatalogItem,
  ): Promise<ReactionOutcome> {
    const { owner, peer, messageId, actor, key } = input;
    const pairs = this.#options.agentPairs;
    if (pairs === undefined) {
      return {
        ok: false,
        code: "NOT_REACTABLE",
        message: `"${owner}" keeps no chat history to react in`,
      };
    }
    const record = await pairs.record(owner, peer, messageId);
    if (record === undefined) {
      return {
        ok: false,
        code: "UNKNOWN_MESSAGE",
        message: `no message "${messageId}" between "${owner}" and "${peer}"`,
      };
    }
    const { store, key: pairKey } = pairs.pair(owner, peer);
    if (input.remove === true) {
      // Only the author removes their own (§10.31) — keyed by (message, actor, key),
      // so "someone else's" is a different key, not a check that can be forgotten.
      const changed = await store.remove(pairKey, messageId, actor, key);
      const reactions = await store.of(pairKey, messageId, actor);
      if (changed) await this.#pushJournal(store, pairKey, owner, messageId);
      return { ok: true, reactions };
    }
    const placed = await store.add(pairKey, messageId, actor, key, item.emoji);
    const reactions = await store.of(pairKey, messageId, actor);
    if (!placed) return { ok: true, reactions }; // idempotent repeat: no count, no notice
    this.#options.usage.bump(key);
    await this.#pushJournal(store, pairKey, owner, messageId);
    const notify = await this.#notify(record, actor, item, messageId, { asPeer: true });
    return { ok: true, reactions, ...(notify !== undefined ? { notify } : {}) };
  }

  /**
   * Push the pair's folded state to the journal watchers (FR-182). Folded for
   * NOBODY on purpose: `mine` on a journal row would claim the operator placed
   * something they cannot place.
   */
  async #pushJournal(
    store: ReactionStore,
    pairKey: string,
    peer: string,
    messageId: string,
  ): Promise<void> {
    const push = this.#journalPush;
    if (push === undefined) return;
    push({ peer, messageId, reactions: await store.of(pairKey, messageId, "") });
  }

  /**
   * A user↔user pair is mirrored on disk (§17.5: each user's log is a copy), so the
   * event is written to BOTH sidecars — otherwise the other human would never see
   * the badge on their own copy of the record. Best-effort: the mirror side may not
   * hold that id, and an event for an unknown id is invisible and compacted away.
   */
  async #mirror(
    owner: string,
    peer: string,
    messageId: string,
    actor: string,
    key: string,
    emoji: string | undefined,
  ): Promise<boolean> {
    if (peer === owner) return false; // notes to self: one log, one sidecar
    const other = this.#options.isAgent(peer) ? undefined : this.#options.ownerOf(peer);
    if (other === undefined) return false; // an agent keeps no panel history (§19.10)
    try {
      return emoji === undefined
        ? await other.reactions.remove(owner, messageId, actor, key)
        : await other.reactions.add(owner, messageId, actor, key, emoji);
    } catch {
      return false; // the mirror is a convenience, never the source of truth
    }
  }

  /** Push the folded state to both sides' tabs (§19.5) — a human sees it live. */
  #broadcast(
    owner: string,
    peer: string,
    messageId: string,
    reactions: readonly ReactionView[],
  ): void {
    this.#push?.(owner, { peer, messageId, reactions });
    if (peer !== owner && !this.#options.isAgent(peer)) {
      // The counterpart's own view of the pair is keyed by the OTHER name.
      this.#push?.(peer, { peer: owner, messageId, reactions });
    }
  }

  /**
   * The asymmetry of §19.6. The author of the marked message is:
   *
   *   - a local AGENT → exactly one `kind:"reaction"` signal through the router,
   *     with a deterministic id (dedup §10.9) and no reply window (§10.30);
   *   - a human → nothing routed: the WS push above IS the notification, and a
   *     badge is not a message (§19.1);
   *   - the actor itself → nothing at all: nobody pings themselves.
   */
  async #notify(
    record: Signal,
    actor: string,
    item: ReactionCatalogItem,
    messageId: string,
    options: { readonly asPeer?: boolean } = {},
  ): Promise<NotifyOutcome | undefined> {
    const author = record.from;
    if (author === actor) return undefined; // self-reaction (§19.6)
    if (!this.#options.isAgent(author)) return undefined; // a human gets the push only
    const route = this.#options.route;
    if (route === undefined) return { delivered: false, code: "UNAVAILABLE" };
    const signal: Signal = {
      // Deterministic id (§19.6): a redelivery is deduped (§10.9) and a repeat
      // placement cannot produce a second injection.
      id: `${messageId}:react:${actor}:${item.key}`,
      from: actor,
      to: author,
      kind: "reaction",
      ts: this.#now(),
      replyTo: messageId,
      origin: `reaction:${item.key}`,
      payload: reactionPayload(item, actor, messageId, options.asPeer === true),
      // The ONE switch (§19.6): a notice by default, a real turn on the operator's
      // explicit opt-in — and between two agents not even that (§19.13, Q3): the
      // opt-in belongs to the operator's voice, so a peer's gesture never becomes
      // an errand.
      ...(item.expectsReply === true && options.asPeer !== true ? { expectsReply: true } : {}),
    };
    try {
      const result = await route(signal);
      return result.ok
        ? { delivered: true }
        : { delivered: false, ...(result.code !== undefined ? { code: result.code } : {}) };
    } catch {
      return { delivered: false, code: "ROUTE_FAILED" };
    }
  }
}

/**
 * What the agent reads (§19.6): a preamble naming the reaction and the message it
 * marks, then the operator's text VERBATIM. A string payload, not an object — this
 * is the shape the tmux render, telegram and slack all already print (FR-25b).
 */
export function reactionPayload(
  item: ReactionCatalogItem,
  actor: string,
  messageId: string,
  /** From a peer AGENT (§19.13): the head line alone — see below. */
  fromPeer = false,
): string {
  const label = item.label ?? item.key;
  const head = `[muxeon reaction] ${item.emoji} ${label} from ${actor} on your message ${messageId}`;
  // Between two agents the head IS the whole receipt (§19.13, FR-181). `agentMessage`
  // is not appended: the operator wrote that text to an agent, in their own voice —
  // several entries of the standard catalog literally begin "Оператор…" — and putting
  // it in a peer's mouth is a lie about who is speaking. The emoji and the label
  // carry everything a receipt has to carry.
  if (fromPeer) return head;
  // No configured text ⇒ the coordinator's own words, and those are ALWAYS English
  // — a protocol surface, like the reply contract (§13.2/T76). The operator's text,
  // when present, is whatever language the operator wrote it in.
  const body =
    item.agentMessage ?? "No instruction is attached — this is how the operator marked it.";
  return `${head}\n${body}`;
}

/** The record with that id in the pair, if the pair holds it (§19.5). */
async function findRecord(
  history: HistoryStore,
  peer: string,
  messageId: string,
): Promise<Signal | undefined> {
  const records = await history.all(peer);
  return records.find((record) => record.id === messageId);
}
