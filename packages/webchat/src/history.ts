// Chat history store (T45, FR-39, §12.3). The queue is NOT the history: done/
// is pruned on the §5.4 window and scattered per session. The panel keeps its
// own durable log — append-only JSONL per (operator, agent) peer:
//
//   <config_dir>/webchat/history/<operator>/<agent>.jsonl
//
// One newline-terminated JSON record (the Signal envelope, §5.3) per line. A
// crash mid-append leaves an unterminated tail — dropped on load. Appends are
// deduped by the record id (at-least-once §10.9 allows a duplicate deliver).
// Retention is the §5.4-style double cap (history.retain, §12.2) with larger
// defaults — history outlives done/. Pruning rewrites the file atomically
// (tmp+rename, same dir ⇒ same FS).
//
// All operations are serialized through one promise chain: the egress
// dispatcher's deliver and HTTP sends append concurrently in one process.

import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import {
  DEFAULT_TOPIC_ID,
  type Topic,
  type TopicCounts,
  TopicError,
  type TopicState,
  type TopicView,
  createTopic,
  findTopic,
  initialTopicState as initialTopics,
  parseTopicState,
  pruneTopicUsage,
  recordTopicUse,
  removeTopic,
  renameTopic,
  subtreeOf,
  topicOfMessage,
  topicViews,
} from "./topics";

/** §12.3 defaults — deliberately wider than the queue's done/ window (§5.4). */
export const HISTORY_DEFAULT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const HISTORY_DEFAULT_COUNT = 10_000;
/**
 * Headroom the inline count cap runs past `count` before trimming (T287) — the
 * same amortization the transport log uses, for the same reason: a rewrite is
 * O(the peer's whole log), so trimming at exactly `count` would make every
 * append past the cap re-serialize and re-write the entire file. A busy peer
 * log is capped at `count * (1 + ratio)` between trims instead of exactly
 * `count`, which is the bound the cap is there for.
 */
export const HISTORY_TRIM_SLACK_RATIO = 0.1;

export interface HistoryRetain {
  readonly ageMs?: number;
  readonly count?: number;
}

export interface HistoryStoreOptions {
  /** Per-operator history dir: <config_dir>/webchat/history/<operator>. */
  readonly dir: string;
  /** The operator this history belongs to — the peer is the OTHER side. */
  readonly operator: string;
  readonly retain?: HistoryRetain;
  readonly now?: () => number;
  /** Topic id source (§23.1) — injectable so tests can predict ids. */
  readonly newId?: () => string;
}

export interface HistoryPage {
  /** Chronological (oldest → newest) slice of the peer's records. */
  readonly records: readonly Signal[];
  /** Cursor for the next (older) page — the id of the oldest record returned. */
  readonly nextBefore?: string;
}

interface PeerCache {
  records: Signal[];
  ids: Set<string>;
  /** The pair's topic sidecar (§23.2) — in memory always, on disk once mutated. */
  topics: TopicState;
}

/** What a topic delete/clear removed (§23.3) — the WS push and reactions need both. */
export interface TopicRemoval {
  readonly topicIds: readonly string[];
  readonly messageIds: readonly string[];
}

/** The topic part of an export (§23.3): the tree and the non-default membership. */
export interface TopicExport {
  readonly defaultId: string;
  readonly topics: readonly Topic[];
  readonly messageTopics: Readonly<Record<string, string>>;
}

/**
 * How long a label may wait for its record before the sweep counts it orphaned:
 * a send labels BEFORE route and appends after it (§23.2), and a retention sweep
 * landing in between must not strip a label that is about to be used.
 */
const LABEL_GRACE_MS = 10 * 60 * 1000;

export class HistoryStore {
  readonly #dir: string;
  readonly #operator: string;
  readonly #ageMs: number;
  readonly #count: number;
  /** Length at which the append path trims back to `#count` (see HISTORY_TRIM_SLACK_RATIO). */
  readonly #trimAt: number;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #peers = new Map<string, PeerCache>();
  /** Labels assigned in this process and not yet backed by a record (LABEL_GRACE_MS). */
  readonly #freshLabels = new Map<string, number>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: HistoryStoreOptions) {
    this.#dir = options.dir;
    this.#operator = options.operator;
    this.#ageMs = options.retain?.ageMs ?? HISTORY_DEFAULT_AGE_MS;
    this.#count = options.retain?.count ?? HISTORY_DEFAULT_COUNT;
    this.#trimAt = this.#count + Math.max(1, Math.ceil(this.#count * HISTORY_TRIM_SLACK_RATIO));
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** The peer (agent) side of a record: the non-operator participant. */
  peerOf(record: Signal): string {
    return record.from === this.#operator ? record.to : record.from;
  }

  /**
   * Append one record under its peer's log. Returns false (and writes nothing)
   * for a duplicate id — the §10.9 dedup for duplicate delivers/retries.
   */
  append(record: Signal): Promise<boolean> {
    return this.#serialize(async () => {
      const peer = this.peerOf(record);
      const cache = await this.#load(peer);
      if (cache.ids.has(record.id)) return false;
      // A record removed with its topic stays removed (§23.3): a re-deliver of
      // the old envelope (at-least-once, §10.9) must not bring it back.
      if (cache.topics.deleted[record.id] !== undefined) return false;
      cache.records.push(record);
      cache.ids.add(record.id);
      await appendFile(this.#file(peer), `${JSON.stringify(record)}\n`, "utf8");
      // An answer joins the topic of the message it answers (§23.2) — the
      // anchor must be a live record of THIS pair; anything else is default.
      if (record.from !== this.#operator && record.replyTo !== undefined) {
        const anchor = cache.topics.labels[record.replyTo];
        if (anchor !== undefined && cache.ids.has(record.replyTo)) {
          cache.topics.labels[record.id] = anchor;
          await this.#saveTopics(peer, cache.topics);
        }
      }
      this.#freshLabels.delete(record.id);
      // The count cap is enforced inline so a hot peer cannot grow unbounded
      // between sweeps; the age cap runs on load and in prune(). Trimming waits
      // for the slack (T287) so the append stays O(1) instead of rewriting the
      // whole peer log on every message past the cap.
      if (cache.records.length > this.#trimAt) await this.#rewrite(peer, cache);
      return true;
    });
  }

  /**
   * Page backwards from `before` (exclusive) or from the newest record. With a
   * `topicId` (§23.3) only that topic's DIRECT records are paged — the same
   * cursor contract over the filtered list; an unknown topic is TOPIC_NOT_FOUND.
   */
  page(
    peer: string,
    options: { before?: string; limit?: number; topicId?: string } = {},
  ): Promise<HistoryPage> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const { topicId } = options;
      if (topicId === undefined) return sliceBackwards(cache.records, options);
      requireTopic(cache.topics, topicId);
      const records = cache.records.filter(
        (record) => topicOfMessage(cache.topics, record.id) === topicId,
      );
      return sliceBackwards(records, options);
    });
  }

  /** The newest record of a peer (peer-list previews, §12.7). */
  last(peer: string): Promise<Signal | undefined> {
    return this.#serialize(async () => (await this.#load(peer)).records.at(-1));
  }

  /**
   * The self-chat projection (§17.7, FR-128): EVERY record of this user, both
   * directions, merged across all pair logs into one chronological thread and
   * paged backwards like an ordinary chat. A projection, not a copy — the pair
   * logs stay the only writers, so nothing here can drift from them.
   */
  projected(options: { before?: string; limit?: number } = {}): Promise<HistoryPage> {
    return this.#serialize(async () => {
      const merged = await this.#merged();
      return sliceBackwards(merged, options);
    });
  }

  /** The newest record across ALL pairs — the self row's preview (§17.7). */
  newest(): Promise<Signal | undefined> {
    return this.#serialize(async () => (await this.#merged()).at(-1));
  }

  /**
   * Every pair's records in one chronological array. Ties break on id so the
   * order is total and stable: paging cursors must land on the same index no
   * matter how the merge ran, and two records CAN share a millisecond.
   */
  async #merged(): Promise<Signal[]> {
    const all: Signal[] = [];
    for (const name of await this.#listFileNames()) {
      const peer = decodePeer(name.slice(0, -".jsonl".length));
      all.push(...(await this.#load(peer)).records);
    }
    return all.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** The peer's FULL chronological log — the §12.3 export source (FR-84). */
  all(peer: string): Promise<readonly Signal[]> {
    return this.#serialize(async () => [...(await this.#load(peer)).records]);
  }

  /**
   * Drop the peer's whole log (FR-84): the cache empties and the file is
   * removed (the same atomic #rewrite path the caps use). Unread falls to 0 by
   * construction — no records, nothing newer than any watermark. Blob BYTES
   * referenced only here become GC-eligible on the next sweep (§5.4).
   */
  clear(peer: string): Promise<void> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      cache.records = [];
      cache.ids.clear();
      await this.#rewrite(peer, cache);
      // The tree stays (§23.1: Clear chat empties every topic, keeps the topics).
      if (Object.keys(cache.topics.labels).length > 0) {
        cache.topics.labels = {};
        await this.#saveTopics(peer, cache.topics);
      }
    });
  }

  /** Peers that have a history file (merged with topology neighbors in T46). */
  peers(): Promise<string[]> {
    return this.#serialize(async () =>
      (await this.#listFileNames()).map((name) => decodePeer(name.slice(0, -".jsonl".length))),
    );
  }

  /**
   * Apply both caps to every peer log (called from the retention sweep, §5.4).
   * The count cap carries the append path's slack here too (T287): the sweep is
   * on a clock, so an exact cap would rewrite every at-cap peer log every minute
   * that saw a message. The age cap stays exact.
   */
  prune(): Promise<void> {
    return this.#serialize(async () => {
      for (const peer of (await this.#listFileNames()).map((name) =>
        decodePeer(name.slice(0, -".jsonl".length)),
      )) {
        const cache = await this.#load(peer);
        const aged = this.#applyAge(cache); // re-check: load's floor is stale for cached peers
        if (aged || cache.records.length > this.#trimAt) await this.#rewrite(peer, cache);
        if (this.#sweepTopics(cache)) await this.#saveTopics(peer, cache.topics);
      }
    });
  }

  /**
   * The sidecar's own retention (§23.2): labels whose record is gone (age/count
   * caps) and tombstones older than the history window go; usage slides by day.
   * Returns whether anything changed.
   */
  #sweepTopics(cache: PeerCache): boolean {
    const state = cache.topics;
    const now = this.#now();
    let changed = pruneTopicUsage(state, now);
    for (const id of Object.keys(state.labels)) {
      if (cache.ids.has(id)) continue;
      const fresh = this.#freshLabels.get(id);
      if (fresh !== undefined && now - fresh < LABEL_GRACE_MS) continue;
      this.#freshLabels.delete(id);
      delete state.labels[id];
      changed = true;
    }
    for (const [id, at] of Object.entries(state.deleted)) {
      if (now - at <= this.#ageMs) continue;
      delete state.deleted[id];
      changed = true;
    }
    return changed;
  }

  /** Absolute log paths — the extra blob-reference source for GC (§12.3/§5.4). */
  listFiles(): Promise<string[]> {
    return this.#serialize(async () =>
      (await this.#listFileNames()).map((name) => join(this.#dir, name)),
    );
  }

  /**
   * Upload-time metadata of a blob referenced anywhere in the history (newest
   * first) — the §12.5 mime/name source for downloads after a restart, when the
   * in-memory upload cache is gone. The id is opaque; byte access still goes
   * through realpath-containment (§8.7) regardless of what is found here.
   */
  findBlobRef(id: string): Promise<{ name?: string; mime?: string } | undefined> {
    return this.#serialize(async () => {
      for (const name of await this.#listFileNames()) {
        const peer = decodePeer(name.slice(0, -".jsonl".length));
        const { records } = await this.#load(peer);
        for (let i = records.length - 1; i >= 0; i -= 1) {
          const payload = records[i]?.payload;
          if (typeof payload !== "object" || payload === null) continue;
          const blobs = (payload as { blobs?: unknown }).blobs;
          if (!Array.isArray(blobs)) continue;
          for (const ref of blobs) {
            if (typeof ref !== "object" || ref === null) continue;
            const candidate = ref as { blob?: unknown; name?: unknown; mime?: unknown };
            if (candidate.blob !== id) continue;
            return {
              ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
              ...(typeof candidate.mime === "string" ? { mime: candidate.mime } : {}),
            };
          }
        }
      }
      return undefined;
    });
  }

  /**
   * One record by id (FR-178, T292) — the quote target of a reply. The pair the
   * caller names is searched first (that is where a chat reply points); the other
   * pair logs follow, because the SELF chat (§17.7) is a projection of all of them
   * and one can quote from it. Absent ⇒ undefined: the panel refuses a reply to a
   * message nobody can show, rather than handing the agent a dangling id.
   */
  find(id: string, peer?: string): Promise<Signal | undefined> {
    return this.#serialize(async () => {
      const names = (await this.#listFileNames()).map((name) =>
        decodePeer(name.slice(0, -".jsonl".length)),
      );
      const order = peer === undefined ? names : [peer, ...names.filter((n) => n !== peer)];
      for (const name of order) {
        const { records } = await this.#load(name);
        for (let i = records.length - 1; i >= 0; i -= 1) {
          const record = records[i];
          if (record?.id === id) return record;
        }
      }
      return undefined;
    });
  }

  // --- read markers (unread badges, FR-40/§12.7) -----------------------------
  // One ts watermark per peer, persisted next to the logs (.read.json,
  // tmp+rename). Unread = inbound records newer than the watermark.

  /**
   * Mark the peer's chat as read up to its newest record. With a `topicId`
   * (§23.3) only that topic moves — other topics keep their unread.
   */
  markRead(peer: string, topicId?: string): Promise<void> {
    return this.#serialize(async () => {
      if (topicId !== undefined) {
        const cache = await this.#load(peer);
        requireTopic(cache.topics, topicId);
        const newest = cache.records.findLast(
          (record) => topicOfMessage(cache.topics, record.id) === topicId,
        );
        cache.topics.read[topicId] = newest?.ts ?? this.#now();
        await this.#saveTopics(peer, cache.topics);
        return;
      }
      const markers = await this.#loadMarkers();
      const newest = (await this.#load(peer)).records.at(-1);
      markers.set(peer, newest?.ts ?? this.#now());
      const tmp = join(this.#dir, ".tmp-read.json");
      await mkdir(this.#dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(Object.fromEntries(markers)), "utf8");
      await rename(tmp, join(this.#dir, ".read.json"));
    });
  }

  /**
   * Inbound records newer than their watermark: the pair's, or their topic's
   * when that is later (§23.3) — so the badge is the sum over the topics, and
   * reading the whole pair still clears every one of them.
   */
  unread(peer: string): Promise<number> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const pairMark = (await this.#loadMarkers()).get(peer) ?? 0;
      return cache.records.filter((record) => this.#isUnread(cache, record, pairMark)).length;
    });
  }

  #isUnread(cache: PeerCache, record: Signal, pairMark: number): boolean {
    if (record.from === this.#operator) return false;
    const topicMark = cache.topics.read[topicOfMessage(cache.topics, record.id)] ?? 0;
    return record.ts > Math.max(pairMark, topicMark);
  }

  // --- topics (§23) -----------------------------------------------------------
  // Every topic operation runs on the same chain as append/clear/retention, so a
  // delete never meets a half-written log (§23.2).

  /** The pair's sorted topic tree with live counts (§23.3 GET /api/topics). */
  topicList(peer: string): Promise<{ topics: TopicView[]; defaultId: string }> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const pairMark = (await this.#loadMarkers()).get(peer) ?? 0;
      const counts = new Map<string, { messages: number; unread: number }>();
      for (const record of cache.records) {
        const topicId = topicOfMessage(cache.topics, record.id);
        const entry = counts.get(topicId) ?? { messages: 0, unread: 0 };
        entry.messages += 1;
        if (this.#isUnread(cache, record, pairMark)) entry.unread += 1;
        counts.set(topicId, entry);
      }
      return {
        topics: topicViews(cache.topics, counts as ReadonlyMap<string, TopicCounts>, this.#now()),
        defaultId: DEFAULT_TOPIC_ID,
      };
    });
  }

  /** POST /api/topics (§23.3): the new topic; missing ancestors come with it. */
  createTopic(peer: string, path: unknown): Promise<Topic> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const topic = createTopic(cache.topics, path, this.#now(), this.#newId);
      await this.#saveTopics(peer, cache.topics);
      return { ...topic };
    });
  }

  /** PATCH /api/topics/:id (§23.3): the re-pathed subtree. */
  renameTopic(peer: string, id: string, path: unknown): Promise<Topic[]> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const moved = renameTopic(cache.topics, id, path, this.#now(), this.#newId);
      await this.#saveTopics(peer, cache.topics);
      return moved.map((topic) => ({ ...topic }));
    });
  }

  /** DELETE /api/topics/:id (§23.3): the subtree AND all its messages. */
  deleteTopic(peer: string, id: string): Promise<TopicRemoval> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const topicIds = removeTopic(cache.topics, id);
      const gone = new Set(topicIds);
      // Orphaned labels of records already gone point at nothing now.
      for (const [messageId, topicId] of Object.entries(cache.topics.labels)) {
        if (gone.has(topicId) && !cache.ids.has(messageId)) delete cache.topics.labels[messageId];
      }
      const messageIds = await this.#removeMessages(peer, cache, gone);
      return { topicIds, messageIds };
    });
  }

  /** POST /api/topics/:id/clear (§23.3): the subtree's messages; topics stay. */
  clearTopic(peer: string, id: string): Promise<TopicRemoval> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      requireTopic(cache.topics, id);
      const topicIds = subtreeOf(cache.topics, id).map((topic) => topic.id);
      const messageIds = await this.#removeMessages(peer, cache, new Set(topicIds));
      return { topicIds, messageIds };
    });
  }

  /**
   * Fixes the topic of an outgoing message BEFORE it is routed (§23.2): the
   * topic must exist in this pair; the same id with another topic is
   * MESSAGE_TOPIC_CONFLICT (a retry may repeat, never re-file). Idempotent.
   */
  assignTopic(peer: string, messageId: string, topicId: string): Promise<void> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      requireTopic(cache.topics, topicId);
      const current =
        cache.topics.labels[messageId] ??
        (cache.ids.has(messageId) || cache.topics.deleted[messageId] !== undefined
          ? DEFAULT_TOPIC_ID
          : undefined);
      if (current !== undefined && current !== topicId) {
        throw new TopicError(
          "MESSAGE_TOPIC_CONFLICT",
          `message "${messageId}" already belongs to another topic`,
        );
      }
      if (current === topicId || topicId === DEFAULT_TOPIC_ID) return;
      cache.topics.labels[messageId] = topicId;
      this.#freshLabels.set(messageId, this.#now());
      await this.#saveTopics(peer, cache.topics);
    });
  }

  /** One successful NEW human send into the topic (§23.4 usage). */
  noteTopicSend(peer: string, topicId: string): Promise<void> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      if (findTopic(cache.topics, topicId) === undefined) return; // deleted meanwhile
      recordTopicUse(cache.topics, topicId, this.#now());
      await this.#saveTopics(peer, cache.topics);
    });
  }

  /**
   * The topic of a record already in this store — synchronous, for the WS push
   * that follows an append (§23.3). A pair not loaded yet has no labels to read,
   * which is the default by definition.
   */
  topicOf(peer: string, messageId: string): string {
    const cache = this.#peers.get(peer);
    return cache === undefined ? DEFAULT_TOPIC_ID : topicOfMessage(cache.topics, messageId);
  }

  /** The topic part of the pair's export (§23.3). */
  topicExport(peer: string): Promise<TopicExport> {
    return this.#serialize(async () => {
      const cache = await this.#load(peer);
      const messageTopics: Record<string, string> = {};
      for (const [id, topicId] of Object.entries(cache.topics.labels)) {
        if (cache.ids.has(id)) messageTopics[id] = topicId;
      }
      return {
        defaultId: DEFAULT_TOPIC_ID,
        topics: cache.topics.topics.map((topic) => ({ ...topic })),
        messageTopics,
      };
    });
  }

  /**
   * Drops every record filed under `topicIds` (§23.3), crash-safe in three
   * steps: the sidecar first records the intent (`pending`) together with the
   * tombstones, then the log is rewritten, then the intent is cleared. A crash
   * anywhere in between is finished by the next #load — no half delete survives
   * a restart, and a re-deliver of a removed id is refused either way.
   */
  async #removeMessages(
    peer: string,
    cache: PeerCache,
    topicIds: ReadonlySet<string>,
  ): Promise<string[]> {
    const state = cache.topics;
    const ids = cache.records
      .filter((record) => topicIds.has(topicOfMessage(state, record.id)))
      .map((record) => record.id);
    const now = this.#now();
    for (const id of ids) {
      delete state.labels[id];
      state.deleted[id] = now;
    }
    state.pending = { ids };
    await this.#saveTopics(peer, state);
    await this.#dropRecords(peer, cache, new Set(ids));
    state.pending = undefined;
    await this.#saveTopics(peer, state);
    return ids;
  }

  async #dropRecords(peer: string, cache: PeerCache, ids: ReadonlySet<string>): Promise<void> {
    const kept = cache.records.filter((record) => !ids.has(record.id));
    if (kept.length === cache.records.length) return;
    cache.records = kept;
    for (const id of ids) cache.ids.delete(id);
    await this.#rewrite(peer, cache);
  }

  #topicsFile(peer: string): string {
    return join(this.#dir, `${encodePeer(peer)}.topics.json`);
  }

  // tmp+rename in the same dir, like the log and the read markers. The name ends
  // in `.json`, not `.jsonl`: #listFileNames must never take it for a peer log.
  async #saveTopics(peer: string, state: TopicState): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const tmp = join(this.#dir, `.tmp-${encodePeer(peer)}.topics.json`);
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, this.#topicsFile(peer));
  }

  async #loadTopics(peer: string, cache: PeerCache): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#topicsFile(peer), "utf8"));
    } catch {
      return; // no sidecar yet — the initial state (default topic only) stands
    }
    cache.topics = parseTopicState(raw, this.#now());
    const pending = cache.topics.pending;
    if (pending === undefined) return;
    // A removal was interrupted (§23.3): finish it before anyone reads the log.
    await this.#dropRecords(peer, cache, new Set(pending.ids));
    cache.topics.pending = undefined;
    await this.#saveTopics(peer, cache.topics);
  }

  #markers: Map<string, number> | undefined;

  async #loadMarkers(): Promise<Map<string, number>> {
    if (this.#markers !== undefined) return this.#markers;
    this.#markers = new Map();
    try {
      const raw = JSON.parse(await readFile(join(this.#dir, ".read.json"), "utf8")) as Record<
        string,
        unknown
      >;
      for (const [peer, ts] of Object.entries(raw)) {
        if (typeof ts === "number") this.#markers.set(peer, ts);
      }
    } catch {
      // no markers yet (or torn write) — everything counts as unread
    }
    return this.#markers;
  }

  /** Drop records past the age floor (§12.3); returns whether anything fell. */
  #applyAge(cache: PeerCache): boolean {
    const floor = this.#now() - this.#ageMs;
    const keep = cache.records.filter((record) => record.ts >= floor);
    if (keep.length === cache.records.length) return false;
    for (const record of cache.records) {
      if (record.ts < floor) cache.ids.delete(record.id);
    }
    cache.records = keep;
    return true;
  }

  #serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(op, op);
    this.#chain = next.catch(() => undefined); // one failed op must not poison the chain
    return next;
  }

  #file(peer: string): string {
    return join(this.#dir, `${encodePeer(peer)}.jsonl`);
  }

  async #listFileNames(): Promise<string[]> {
    try {
      return (await readdir(this.#dir)).filter((name) => name.endsWith(".jsonl")).sort();
    } catch {
      return []; // no history yet
    }
  }

  async #load(peer: string): Promise<PeerCache> {
    const cached = this.#peers.get(peer);
    if (cached !== undefined) return cached;
    await mkdir(this.#dir, { recursive: true });
    const cache: PeerCache = { records: [], ids: new Set(), topics: initialTopics(this.#now()) };
    let raw: string;
    try {
      raw = await readFile(this.#file(peer), "utf8");
    } catch {
      this.#peers.set(peer, cache);
      await this.#loadTopics(peer, cache);
      return cache;
    }
    // A complete file ends with "\n"; a non-empty final chunk is a crash-torn
    // tail and is dropped (the §12.3 read rule). Unparsable lines are skipped,
    // not fatal — one corrupt record must not take the whole chat down.
    const lines = raw.split("\n");
    const torn = lines.at(-1) !== "";
    const complete = lines.slice(0, -1);
    const floor = this.#now() - this.#ageMs;
    let dropped = torn;
    for (const line of complete) {
      if (line === "") continue;
      let record: Signal;
      try {
        record = JSON.parse(line) as Signal;
      } catch {
        dropped = true;
        continue;
      }
      if (typeof record.id !== "string" || typeof record.ts !== "number") {
        dropped = true;
        continue;
      }
      if (record.ts < floor) {
        dropped = true; // age cap (§12.3): expired on load
        continue;
      }
      if (cache.ids.has(record.id)) continue;
      cache.records.push(record);
      cache.ids.add(record.id);
    }
    this.#peers.set(peer, cache);
    if (dropped) await this.#rewrite(peer, cache); // persist the cleaned view
    await this.#loadTopics(peer, cache);
    return cache;
  }

  // Atomic rewrite (tmp+rename in the same dir): applies the count cap to the
  // in-memory cache, then replaces the log with exactly the cached records.
  async #rewrite(peer: string, cache: PeerCache): Promise<void> {
    if (cache.records.length > this.#count) {
      const cut = cache.records.splice(0, cache.records.length - this.#count);
      for (const record of cut) cache.ids.delete(record.id);
    }
    const file = this.#file(peer);
    const tmp = join(this.#dir, `.tmp-${encodePeer(peer)}.jsonl`);
    if (cache.records.length === 0) {
      try {
        await unlink(file);
      } catch {
        // never existed
      }
      return;
    }
    const body = cache.records.map((record) => JSON.stringify(record)).join("\n");
    await writeFile(tmp, `${body}\n`, "utf8");
    await rename(tmp, file);
  }
}

function requireTopic(state: TopicState, id: string): void {
  if (findTopic(state, id) === undefined) {
    throw new TopicError("TOPIC_NOT_FOUND", `unknown topic "${id}"`);
  }
}

/**
 * One page backwards from `before` (exclusive) — shared by the per-peer thread
 * and the self-chat projection so both cursors behave identically. An unknown
 * cursor yields an empty page rather than the newest one: a stale id must not
 * silently restart the scroll from the bottom.
 */
function sliceBackwards(
  records: readonly Signal[],
  options: { before?: string; limit?: number },
): HistoryPage {
  const limit = options.limit ?? 50;
  let end = records.length;
  if (options.before !== undefined) {
    const at = records.findIndex((record) => record.id === options.before);
    end = at === -1 ? 0 : at;
  }
  const start = Math.max(0, end - limit);
  const slice = records.slice(start, end);
  const first = slice[0];
  return {
    records: slice,
    ...(start > 0 && first !== undefined ? { nextBefore: first.id } : {}),
  };
}

// Peer names are config-validated participants, but they become file names here —
// encode anything outside [A-Za-z0-9_-] (codepoint hex between % delimiters) so a
// hostile-looking name cannot traverse or hide (defense in depth, §8.7; mirrors
// the router's id sanitation stance §10.11).
//
// Exported as `encodePeerName` for the reaction sidecar (§19.4), which keys its
// files by the same pairs: ONE implementation, because file naming is a security
// surface and two copies of it would drift.
export { encodePeer as encodePeerName };

function encodePeer(peer: string): string {
  return peer.replace(/[^A-Za-z0-9_-]/gu, (char) => `%${char.codePointAt(0)?.toString(16)}%`);
}

function decodePeer(encoded: string): string {
  return encoded.replace(/%([0-9a-f]+)%/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}
