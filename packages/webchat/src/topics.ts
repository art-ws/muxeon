// Conversation topics (§23, FR-208…FR-217) — the pure model. A topic splits the
// panel history of ONE pair (signed-in user, agent) into feeds; the pair's JSONL
// stays the single log and membership lives beside it, keyed by message id
// (§23.2). Everything here is DOM- and fs-free so `bun test` covers the rules;
// HistoryStore owns persistence and serialization.
//
// A topic is {id, path, createdAt}: `id` is immutable and is what messages point
// at, `path` is a mutable display name whose `/` separates tree levels. The tree
// is DERIVED from the paths — the parent of `A/B` is whatever topic is called
// `A` — so a rename of a parent re-paths its whole subtree without touching a
// single message.

/** The fixed id of a pair's default topic (§23.1) — every unlabelled record. */
export const DEFAULT_TOPIC_ID = "default";
/** The default topic's initial name (§23.1, the operator's word). */
export const DEFAULT_TOPIC_PATH = "Общая";
/** Usage counts the human's new sends of the last 30 days, in day buckets (§23.4). */
export const TOPIC_USAGE_WINDOW_DAYS = 30;
/** Defensive cap on a whole path; a name is something a human types. */
export const TOPIC_PATH_MAX = 256;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TopicErrorCode =
  | "INVALID_TOPIC_PATH"
  | "TOPIC_EXISTS"
  | "TOPIC_CONFLICT"
  | "TOPIC_NOT_FOUND"
  | "DEFAULT_TOPIC"
  | "MESSAGE_TOPIC_CONFLICT";

/** A refused topic operation; the code is the API's (§23.3). */
export class TopicError extends Error {
  readonly code: TopicErrorCode;
  constructor(code: TopicErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Topic {
  readonly id: string;
  path: string;
  readonly createdAt: number;
}

/**
 * The sidecar of one pair (§23.2). Labels exist only for records OUTSIDE the
 * default topic — an absent label IS the default, which is how the whole
 * pre-§23 log belongs to it without being rewritten.
 */
export interface TopicState {
  topics: Topic[];
  /** messageId → topicId, non-default topics only. */
  labels: Record<string, string>;
  /** topicId → {day index (UTC days since epoch) → new human sends}. */
  usage: Record<string, Record<string, number>>;
  /** topicId → ts of its last counted send (direct, not subtree). */
  lastUsed: Record<string, number>;
  /** topicId → read watermark (§23.3); the pair's own watermark still applies. */
  read: Record<string, number>;
  /** Ids removed by a topic delete/clear → when: a re-deliver must not revive them. */
  deleted: Record<string, number>;
  /** A removal in flight: these ids are leaving the log (crash intent, §23.3). */
  pending?: { readonly ids: readonly string[] } | undefined;
}

/** What the panel lists for one topic (§23.3 GET /api/topics). */
export interface TopicView {
  readonly id: string;
  readonly path: string;
  readonly parentId: string | null;
  readonly createdAt: number;
  readonly usage30d: number;
  readonly lastUsedAt: number | null;
  readonly unread: number;
  readonly messageCount: number;
  readonly subtreeMessageCount: number;
}

/** A pair's state before anything was ever written — just the default topic. */
export function initialTopicState(now: number): TopicState {
  return {
    topics: [{ id: DEFAULT_TOPIC_ID, path: DEFAULT_TOPIC_PATH, createdAt: now }],
    labels: {},
    usage: {},
    lastUsed: {},
    read: {},
    deleted: {},
  };
}

/**
 * Validates and canonicalizes a path (§23.1): every segment trimmed and NFC,
 * none empty, none `.`/`..`, no control characters; no leading/trailing `/`.
 */
export function normalizeTopicPath(raw: unknown): string {
  if (typeof raw !== "string") throw invalid("path must be a string");
  const segments = raw.split("/").map((segment) => segment.normalize("NFC").trim());
  for (const segment of segments) {
    if (segment === "") throw invalid("empty segment — no leading, trailing or double '/'");
    if (segment === "." || segment === "..") throw invalid(`segment "${segment}" is reserved`);
    if (/\p{Cc}/u.test(segment)) throw invalid("control characters are not allowed");
  }
  const path = segments.join("/");
  if (path.length > TOPIC_PATH_MAX) throw invalid(`path is longer than ${TOPIC_PATH_MAX}`);
  return path;
}

function invalid(why: string): TopicError {
  return new TopicError("INVALID_TOPIC_PATH", `invalid topic path: ${why}`);
}

/** Paths are unique per pair regardless of case; the typed case is kept for display. */
function pathKey(path: string): string {
  return path.toLocaleLowerCase();
}

function parentPathOf(path: string): string | undefined {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? undefined : path.slice(0, cut);
}

export function findTopic(state: TopicState, id: string): Topic | undefined {
  return state.topics.find((topic) => topic.id === id);
}

export function findTopicByPath(state: TopicState, path: string): Topic | undefined {
  const key = pathKey(path);
  return state.topics.find((topic) => pathKey(topic.path) === key);
}

/** The topic itself and every descendant (paths under `<path>/`). */
export function subtreeOf(state: TopicState, id: string): Topic[] {
  const root = findTopic(state, id);
  if (root === undefined) return [];
  const prefix = `${pathKey(root.path)}/`;
  return state.topics.filter(
    (topic) => topic.id === root.id || pathKey(topic.path).startsWith(prefix),
  );
}

/** The topic a record belongs to — its label, or the default (§23.1). */
export function topicOfMessage(state: TopicState, messageId: string): string {
  return state.labels[messageId] ?? DEFAULT_TOPIC_ID;
}

/** Creates every missing ancestor of `path` (not `path` itself). */
function ensureAncestors(state: TopicState, path: string, now: number, newId: () => string): void {
  const parent = parentPathOf(path);
  if (parent === undefined || findTopicByPath(state, parent) !== undefined) return;
  ensureAncestors(state, parent, now, newId);
  state.topics.push({ id: newId(), path: parent, createdAt: now });
}

/**
 * Creates `path` and any missing ancestors in one step (§23.1). An existing
 * path — in any case — is `TOPIC_EXISTS`.
 */
export function createTopic(
  state: TopicState,
  rawPath: unknown,
  now: number,
  newId: () => string,
): Topic {
  const path = normalizeTopicPath(rawPath);
  if (findTopicByPath(state, path) !== undefined) {
    throw new TopicError("TOPIC_EXISTS", `topic "${path}" already exists`);
  }
  ensureAncestors(state, path, now, newId);
  const topic: Topic = { id: newId(), path, createdAt: now };
  state.topics.push(topic);
  return topic;
}

/**
 * Renames/moves a topic with its whole subtree (§23.3 PATCH): ids and message
 * membership stay, only paths change; missing ancestors of the new path are
 * created. The default topic may only become another ROOT path (§23.1). A move
 * into its own subtree, or any new path colliding with a topic outside the
 * subtree, is `TOPIC_CONFLICT`. Returns the re-pathed subtree.
 */
export function renameTopic(
  state: TopicState,
  id: string,
  rawPath: unknown,
  now: number,
  newId: () => string,
): Topic[] {
  const topic = findTopic(state, id);
  if (topic === undefined) throw new TopicError("TOPIC_NOT_FOUND", `unknown topic "${id}"`);
  const path = normalizeTopicPath(rawPath);
  if (id === DEFAULT_TOPIC_ID && path.includes("/")) {
    throw new TopicError("DEFAULT_TOPIC", "the default topic can only be renamed to a root path");
  }
  if (pathKey(path).startsWith(`${pathKey(topic.path)}/`)) {
    throw new TopicError("TOPIC_CONFLICT", "a topic cannot move under itself");
  }
  const subtree = subtreeOf(state, id);
  const inside = new Set(subtree.map((member) => member.id));
  const moved = subtree.map((member) => ({
    member,
    path: path + member.path.slice(topic.path.length),
  }));
  for (const { path: target } of moved) {
    const clash = findTopicByPath(state, target);
    if (clash !== undefined && !inside.has(clash.id)) {
      throw new TopicError("TOPIC_CONFLICT", `topic "${clash.path}" already exists`);
    }
  }
  for (const entry of moved) entry.member.path = entry.path;
  ensureAncestors(state, path, now, newId);
  return subtreeOf(state, id);
}

/**
 * Removes a topic with its subtree from the tree (§23.3 DELETE) and returns the
 * removed ids. Messages are the caller's: HistoryStore drops them in the same
 * serialized step. The default topic is never removed.
 */
export function removeTopic(state: TopicState, id: string): string[] {
  if (id === DEFAULT_TOPIC_ID) {
    throw new TopicError("DEFAULT_TOPIC", "the default topic cannot be deleted");
  }
  const subtree = subtreeOf(state, id);
  if (subtree.length === 0) throw new TopicError("TOPIC_NOT_FOUND", `unknown topic "${id}"`);
  const gone = new Set(subtree.map((topic) => topic.id));
  state.topics = state.topics.filter((topic) => !gone.has(topic.id));
  for (const topicId of gone) {
    delete state.usage[topicId];
    delete state.lastUsed[topicId];
    delete state.read[topicId];
  }
  return [...gone];
}

function dayOf(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

/** One successful new human send from the panel into `topicId` (§23.4). */
export function recordTopicUse(state: TopicState, topicId: string, now: number): void {
  const day = String(dayOf(now));
  const buckets = state.usage[topicId] ?? {};
  buckets[day] = (buckets[day] ?? 0) + 1;
  state.usage[topicId] = buckets;
  state.lastUsed[topicId] = now;
}

/** Direct sends of the last 30 days (today included). */
function directUsage(state: TopicState, topicId: string, now: number): number {
  const floor = dayOf(now) - TOPIC_USAGE_WINDOW_DAYS;
  let sum = 0;
  for (const [day, count] of Object.entries(state.usage[topicId] ?? {})) {
    if (Number(day) > floor) sum += count;
  }
  return sum;
}

/** Drops day buckets that slid out of the window; returns whether any fell. */
export function pruneTopicUsage(state: TopicState, now: number): boolean {
  const floor = dayOf(now) - TOPIC_USAGE_WINDOW_DAYS;
  let changed = false;
  for (const [topicId, buckets] of Object.entries(state.usage)) {
    for (const day of Object.keys(buckets)) {
      if (Number(day) <= floor) {
        delete buckets[day];
        changed = true;
      }
    }
    if (Object.keys(buckets).length === 0) delete state.usage[topicId];
  }
  return changed;
}

/** Per-topic message figures HistoryStore counts from the live log. */
export interface TopicCounts {
  readonly messages: number;
  readonly unread: number;
}

/**
 * The tree as the panel shows it (§23.4): depth-first, each node followed by
 * its children; siblings by subtree usage of the last 30 days (desc), then the
 * subtree's last use (desc), then name and id — a total, stable order. The
 * default topic is sorted like any other: no pinning.
 */
export function topicViews(
  state: TopicState,
  counts: ReadonlyMap<string, TopicCounts>,
  now: number,
): TopicView[] {
  const byKey = new Map(state.topics.map((topic) => [pathKey(topic.path), topic]));
  const parentOf = (topic: Topic): Topic | undefined => {
    const parent = parentPathOf(topic.path);
    return parent === undefined ? undefined : byKey.get(pathKey(parent));
  };
  const children = new Map<string | null, Topic[]>();
  for (const topic of state.topics) {
    const parentId = parentOf(topic)?.id ?? null;
    children.set(parentId, [...(children.get(parentId) ?? []), topic]);
  }
  const usage = new Map<string, number>();
  const lastUsed = new Map<string, number | null>();
  const subtreeMessages = new Map<string, number>();
  const fold = (topic: Topic): void => {
    let use = directUsage(state, topic.id, now);
    let last = state.lastUsed[topic.id] ?? null;
    let messages = counts.get(topic.id)?.messages ?? 0;
    for (const child of children.get(topic.id) ?? []) {
      fold(child);
      use += usage.get(child.id) ?? 0;
      const childLast = lastUsed.get(child.id) ?? null;
      if (childLast !== null && (last === null || childLast > last)) last = childLast;
      messages += subtreeMessages.get(child.id) ?? 0;
    }
    usage.set(topic.id, use);
    lastUsed.set(topic.id, last);
    subtreeMessages.set(topic.id, messages);
  };
  for (const root of children.get(null) ?? []) fold(root);
  const leaf = (topic: Topic): string => topic.path.slice(topic.path.lastIndexOf("/") + 1);
  const order = (a: Topic, b: Topic): number =>
    (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) ||
    (lastUsed.get(b.id) ?? -1) - (lastUsed.get(a.id) ?? -1) ||
    leaf(a).localeCompare(leaf(b)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const views: TopicView[] = [];
  const walk = (parentId: string | null): void => {
    for (const topic of [...(children.get(parentId) ?? [])].sort(order)) {
      views.push({
        id: topic.id,
        path: topic.path,
        parentId,
        createdAt: topic.createdAt,
        usage30d: usage.get(topic.id) ?? 0,
        lastUsedAt: lastUsed.get(topic.id) ?? null,
        unread: counts.get(topic.id)?.unread ?? 0,
        messageCount: counts.get(topic.id)?.messages ?? 0,
        subtreeMessageCount: subtreeMessages.get(topic.id) ?? 0,
      });
      walk(topic.id);
    }
  };
  walk(null);
  return views;
}

/**
 * Reads a sidecar leniently: anything malformed falls back to the initial state
 * piece by piece, and the default topic is always present — a broken file must
 * cost at most the topic split, never the chat.
 */
export function parseTopicState(raw: unknown, now: number): TopicState {
  const state = initialTopicState(now);
  if (typeof raw !== "object" || raw === null) return state;
  const source = raw as Record<string, unknown>;
  if (Array.isArray(source.topics)) {
    const topics: Topic[] = [];
    for (const entry of source.topics) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, path, createdAt } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof path !== "string" || typeof createdAt !== "number") {
        continue;
      }
      topics.push({ id, path, createdAt });
    }
    const fallback = state.topics;
    state.topics = topics.some((topic) => topic.id === DEFAULT_TOPIC_ID)
      ? topics
      : [...fallback, ...topics];
  }
  state.labels = stringRecord(source.labels);
  state.lastUsed = numberRecord(source.lastUsed);
  state.read = numberRecord(source.read);
  state.deleted = numberRecord(source.deleted);
  if (typeof source.usage === "object" && source.usage !== null) {
    for (const [topicId, buckets] of Object.entries(source.usage)) {
      const clean = numberRecord(buckets);
      if (Object.keys(clean).length > 0) state.usage[topicId] = clean;
    }
  }
  const pending = (source.pending as { ids?: unknown } | undefined)?.ids;
  if (Array.isArray(pending)) {
    state.pending = { ids: pending.filter((id): id is string => typeof id === "string") };
  }
  return state;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
  return out;
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "number") out[key] = entry;
  return out;
}
