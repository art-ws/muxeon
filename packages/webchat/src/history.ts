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
import type { Signal } from "@teamai/core";

/** §12.3 defaults — deliberately wider than the queue's done/ window (§5.4). */
export const HISTORY_DEFAULT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const HISTORY_DEFAULT_COUNT = 10_000;

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
}

export class HistoryStore {
  readonly #dir: string;
  readonly #operator: string;
  readonly #ageMs: number;
  readonly #count: number;
  readonly #now: () => number;
  readonly #peers = new Map<string, PeerCache>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: HistoryStoreOptions) {
    this.#dir = options.dir;
    this.#operator = options.operator;
    this.#ageMs = options.retain?.ageMs ?? HISTORY_DEFAULT_AGE_MS;
    this.#count = options.retain?.count ?? HISTORY_DEFAULT_COUNT;
    this.#now = options.now ?? Date.now;
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
      cache.records.push(record);
      cache.ids.add(record.id);
      await appendFile(this.#file(peer), `${JSON.stringify(record)}\n`, "utf8");
      // The count cap is enforced inline so a hot peer cannot grow unbounded
      // between sweeps; the age cap runs on load and in prune().
      if (cache.records.length > this.#count) await this.#rewrite(peer, cache);
      return true;
    });
  }

  /** Page backwards from `before` (exclusive) or from the newest record. */
  page(peer: string, options: { before?: string; limit?: number } = {}): Promise<HistoryPage> {
    return this.#serialize(async () => sliceBackwards((await this.#load(peer)).records, options));
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
    });
  }

  /** Peers that have a history file (merged with topology neighbors in T46). */
  peers(): Promise<string[]> {
    return this.#serialize(async () =>
      (await this.#listFileNames()).map((name) => decodePeer(name.slice(0, -".jsonl".length))),
    );
  }

  /** Apply both caps to every peer log (called from the retention sweep, §5.4). */
  prune(): Promise<void> {
    return this.#serialize(async () => {
      for (const peer of (await this.#listFileNames()).map((name) =>
        decodePeer(name.slice(0, -".jsonl".length)),
      )) {
        const cache = await this.#load(peer);
        const aged = this.#applyAge(cache); // re-check: load's floor is stale for cached peers
        if (aged || cache.records.length > this.#count) await this.#rewrite(peer, cache);
      }
    });
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

  // --- read markers (unread badges, FR-40/§12.7) -----------------------------
  // One ts watermark per peer, persisted next to the logs (.read.json,
  // tmp+rename). Unread = inbound records newer than the watermark.

  /** Mark the peer's chat as read up to its newest record. */
  markRead(peer: string): Promise<void> {
    return this.#serialize(async () => {
      const markers = await this.#loadMarkers();
      const newest = (await this.#load(peer)).records.at(-1);
      markers.set(peer, newest?.ts ?? this.#now());
      const tmp = join(this.#dir, ".tmp-read.json");
      await mkdir(this.#dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(Object.fromEntries(markers)), "utf8");
      await rename(tmp, join(this.#dir, ".read.json"));
    });
  }

  /** Inbound records newer than the peer's read watermark. */
  unread(peer: string): Promise<number> {
    return this.#serialize(async () => {
      const watermark = (await this.#loadMarkers()).get(peer) ?? 0;
      const { records } = await this.#load(peer);
      return records.filter((r) => r.from !== this.#operator && r.ts > watermark).length;
    });
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
    const cache: PeerCache = { records: [], ids: new Set() };
    let raw: string;
    try {
      raw = await readFile(this.#file(peer), "utf8");
    } catch {
      this.#peers.set(peer, cache);
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
function encodePeer(peer: string): string {
  return peer.replace(/[^A-Za-z0-9_-]/gu, (char) => `%${char.codePointAt(0)?.toString(16)}%`);
}

function decodePeer(encoded: string): string {
  return encoded.replace(/%([0-9a-f]+)%/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}
