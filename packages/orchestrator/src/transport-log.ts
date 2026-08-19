// Transport log (T64, FR-48, §8.2). The router is the single delivery point —
// observability of the WHOLE transport taps it there: every successfully routed
// Signal is appended (via the router's onRouted hook, OFF the hot delivery
// path — a log failure must never fail a route) to one server-wide append-only
// JSONL:
//
//   <root>/observe/transport.jsonl
//
// Format and read rules mirror the webchat history (§12.3): one newline-
// terminated JSON record per line, dedup by id (at-least-once §10.9), a
// crash-torn tail is dropped on load, retention is the §5.4-style double cap
// swept with the server policy. Records keep their blob references visible to
// the GC (listFiles → extraRefFiles). The baseline consumer is the web panel's
// read-only observability port (§12.4): backward-cursor pages + a live
// subscription for the WS push.

import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Signal } from "@muxeon/core";

/** §5.4-spirit defaults — the log is a view, not the source of truth (§12.3). */
export const TRANSPORT_DEFAULT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const TRANSPORT_DEFAULT_COUNT = 10_000;
/**
 * Headroom the inline count cap is allowed to run past `count` before it trims
 * (T287). A rewrite is O(whole log) — it serializes every cached record into one
 * string and replaces the file — so triggering it the moment the log is one over
 * the cap makes EVERY subsequent append rewrite the entire journal: at the
 * default cap that is ~25 MB of transient allocation and ~25 MB of disk write
 * per routed signal, which is what made the coordinator's heap balloon. With
 * headroom the same rewrite is amortized over `count * ratio` appends, and the
 * bound the cap exists for still holds — the log is simply capped at
 * `count * (1 + ratio)` between trims instead of exactly `count`.
 */
export const TRIM_SLACK_RATIO = 0.1;

export interface TransportRetain {
  readonly ageMs?: number;
  readonly count?: number;
}

export interface TransportLogOptions {
  /** Queue root <root> (§5.3); the log lives at <root>/observe/transport.jsonl. */
  readonly root: string;
  readonly retain?: TransportRetain;
  readonly now?: () => number;
}

export interface TransportPage {
  /** Chronological (oldest → newest) slice of the log. */
  readonly records: readonly Signal[];
  /** Cursor for the next (older) page — the id of the oldest record returned. */
  readonly nextBefore?: string;
}

interface Cache {
  records: Signal[];
  ids: Set<string>;
}

export class TransportLog {
  readonly #file: string;
  readonly #ageMs: number;
  readonly #count: number;
  /** Length at which the append path trims back to `#count` (see TRIM_SLACK_RATIO). */
  readonly #trimAt: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(record: Signal) => void>();
  #cache: Cache | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: TransportLogOptions) {
    this.#file = join(options.root, "observe", "transport.jsonl");
    this.#ageMs = options.retain?.ageMs ?? TRANSPORT_DEFAULT_AGE_MS;
    this.#count = options.retain?.count ?? TRANSPORT_DEFAULT_COUNT;
    this.#trimAt = this.#count + Math.max(1, Math.ceil(this.#count * TRIM_SLACK_RATIO));
    this.#now = options.now ?? Date.now;
  }

  /**
   * Append one routed record; duplicates by id are a no-op (§10.9 allows a
   * duplicate route on retry). Listeners fire for FRESH records only, after
   * the line is durable. Never throws — the router's onRouted caller must not
   * be poisoned by a log error (FR-48).
   */
  append(record: Signal): Promise<boolean> {
    return this.#serialize(async () => {
      try {
        const cache = await this.#load();
        if (cache.ids.has(record.id)) return false;
        cache.records.push(record);
        cache.ids.add(record.id);
        await appendFile(this.#file, `${JSON.stringify(record)}\n`, "utf8");
        // Inline count cap (the §12.3 stance): a hot transport cannot grow
        // unbounded between sweeps; the age cap runs on load and in prune().
        // Trimming waits for the slack (T287) — the append itself is O(1), and
        // paying an O(whole log) rewrite per routed signal is what it must not be.
        if (cache.records.length > this.#trimAt) await this.#rewrite(cache);
      } catch {
        return false; // best-effort observability — never fails the route
      }
      for (const listener of this.#listeners) {
        try {
          listener(record);
        } catch {
          // a broken subscriber must not break the log or its siblings
        }
      }
      return true;
    });
  }

  /** Page backwards from `before` (exclusive) or from the newest record. */
  page(options: { before?: string; limit?: number } = {}): Promise<TransportPage> {
    return this.#serialize(async () => {
      const limit = options.limit ?? 50;
      const { records } = await this.#load();
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
    });
  }

  /**
   * The last `limit` records EXCHANGED between `a` and `b` — both directions,
   * chronological (T126, FR-87). The agent-plane history tool reads its chat
   * with a peer here: the transport log is the one place agent↔agent traffic
   * is durable (the webchat history §12.3 covers operator pairs only).
   */
  pair(a: string, b: string, limit: number): Promise<readonly Signal[]> {
    return this.#serialize(async () => {
      const { records } = await this.#load();
      const out: Signal[] = [];
      for (let i = records.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const record = records[i];
        if (record === undefined) continue;
        if ((record.from === a && record.to === b) || (record.from === b && record.to === a)) {
          out.push(record);
        }
      }
      return out.reverse();
    });
  }

  /** Live feed for the panel's WS push (§12.4); returns the unsubscribe. */
  subscribe(listener: (record: Signal) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Apply both caps (called from the retention sweep, §5.4). The count cap gets
   * the same slack as the append path (T287) — and for the sweep it matters MORE:
   * the sweep runs on a clock (60 s), so trimming at exactly `count` means one
   * full-log rewrite per minute for as long as any traffic arrives, which on a
   * stand that sees a few messages a minute is a rewrite per message all over
   * again. With the slack the rewrite is paid once per `count * ratio` records
   * whoever notices first. The AGE cap stays exact: an expired record leaves on
   * the sweep that finds it, and that rewrite only happens when one actually did.
   */
  prune(): Promise<void> {
    return this.#serialize(async () => {
      const cache = await this.#load();
      const aged = this.#applyAge(cache); // re-check: load's floor goes stale
      if (aged || cache.records.length > this.#trimAt) await this.#rewrite(cache);
    });
  }

  /** Absolute log paths — the extra blob-reference source for GC (§5.4). */
  listFiles(): Promise<string[]> {
    return this.#serialize(async () => {
      try {
        // Existence only — `stat`, not a read of the whole journal (T287): the
        // GC sweep asks this every pass and the log is megabytes.
        await stat(this.#file);
        return [this.#file];
      } catch {
        return []; // no log yet
      }
    });
  }

  #applyAge(cache: Cache): boolean {
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

  async #load(): Promise<Cache> {
    if (this.#cache !== undefined) return this.#cache;
    await mkdir(dirname(this.#file), { recursive: true });
    const cache: Cache = { records: [], ids: new Set() };
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch {
      this.#cache = cache;
      return cache;
    }
    // The §12.3 read rule: a complete file ends with "\n" — a non-empty final
    // chunk is a crash-torn tail and is dropped; unparsable lines are skipped.
    const lines = raw.split("\n");
    let dropped = lines.at(-1) !== "";
    const floor = this.#now() - this.#ageMs;
    for (const line of lines.slice(0, -1)) {
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
        dropped = true; // age cap: expired on load
        continue;
      }
      if (cache.ids.has(record.id)) continue;
      cache.records.push(record);
      cache.ids.add(record.id);
    }
    this.#cache = cache;
    if (dropped) await this.#rewrite(cache); // persist the cleaned view
    return cache;
  }

  // Atomic rewrite (tmp+rename in the same dir): applies the count cap to the
  // in-memory cache, then replaces the log with exactly the cached records.
  async #rewrite(cache: Cache): Promise<void> {
    if (cache.records.length > this.#count) {
      const cut = cache.records.splice(0, cache.records.length - this.#count);
      for (const record of cut) cache.ids.delete(record.id);
    }
    if (cache.records.length === 0) {
      try {
        await unlink(this.#file);
      } catch {
        // never existed
      }
      return;
    }
    const tmp = join(dirname(this.#file), ".tmp-transport.jsonl");
    const body = cache.records.map((record) => JSON.stringify(record)).join("\n");
    await writeFile(tmp, `${body}\n`, "utf8");
    await rename(tmp, this.#file);
  }
}
