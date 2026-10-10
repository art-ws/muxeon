// Conversation topics on the panel side (§23.4, §23.6) — the DOM-free half, so
// `bun test` covers it: thread keys, path pieces, the local search, which topic
// a chat opens on, and the per-pair memory of the last choice.

import type { TopicList, TopicView } from "./types";

/**
 * A topic feed's key in the store (§23.3). The plain peer name stays the key of
 * the WHOLE log — the feed shown with topics off (§23.6) — so switching topics
 * on and off only changes which thread is on screen. `\u0001` cannot occur in a
 * peer name the config accepts, so the two key spaces never collide.
 */
export const topicThreadKey = (peer: string, topicId: string): string => `${peer}\u0001${topicId}`;

/** The last path segment — what a tree row prints (§23.1). */
export const leafOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Everything before the leaf, with the trailing `/` — dimmed in the header field. */
export const ancestorsOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/** Tree depth: 0 for a root topic. */
export const depthOf = (path: string): number => path.split("/").length - 1;

/**
 * The local path search (§23.4): rows whose FULL path contains the needle,
 * case-insensitively, in the server's order — the search filters, it never
 * re-sorts siblings. A blank needle keeps every row.
 */
export function filterTopics(topics: readonly TopicView[], query: string): readonly TopicView[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return topics;
  return topics.filter((topic) => topic.path.toLocaleLowerCase().includes(needle));
}

/**
 * Which topic a chat opens on (§23.4): the deep link's, else the one this pair
 * last had, else the default. A link to a topic that no longer exists falls
 * back to the default and says so (`stale`) — the panel shows a notice instead
 * of an empty feed. Before the list has arrived nothing can be checked: the
 * wanted id is used as is and verified once the list lands.
 */
export function resolveTopic(
  list: TopicList | undefined,
  linked: string | undefined,
  remembered: string | undefined,
): { readonly id: string | undefined; readonly stale: boolean } {
  if (list === undefined) return { id: linked ?? remembered, stale: false };
  const exists = (id: string | undefined): id is string =>
    id !== undefined && list.topics.some((topic) => topic.id === id);
  if (exists(linked)) return { id: linked, stale: false };
  if (linked !== undefined) return { id: list.defaultId, stale: true };
  if (exists(remembered)) return { id: remembered, stale: false };
  return { id: list.defaultId, stale: false };
}

interface TopicStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// One key per (signed-in user, agent): a shared browser can host two users, and
// their topic trees are different trees (§23.1).
const lastKey = (owner: string, peer: string): string =>
  `muxeon-pref:topic:${encodeURIComponent(owner)}:${encodeURIComponent(peer)}`;

/** The topic this pair last had open (§23.4); undefined when unknown or unreadable. */
export function loadLastTopic(
  owner: string,
  peer: string,
  storage: TopicStorage = localStorage,
): string | undefined {
  try {
    const raw = storage.getItem(lastKey(owner, peer));
    return raw === null || raw === "" ? undefined : raw;
  } catch {
    return undefined; // storage blocked — the default topic it is
  }
}

/** Best-effort persist — the panel still switches topics for the session. */
export function saveLastTopic(
  owner: string,
  peer: string,
  topicId: string,
  storage: TopicStorage = localStorage,
): void {
  try {
    storage.setItem(lastKey(owner, peer), topicId);
  } catch {
    // not persisted
  }
}

/** The human wording of a refused topic operation (§23.3 codes) — an English t() key. */
export function topicErrorText(code: string | undefined): string {
  switch (code) {
    case "INVALID_TOPIC_PATH":
      return "Invalid name: no empty parts, no leading or trailing /";
    case "TOPIC_EXISTS":
      return "A topic with this name already exists";
    case "TOPIC_CONFLICT":
      return "That name is taken, or the topic would move under itself";
    case "DEFAULT_TOPIC":
      return "The default topic cannot be deleted or moved under another topic";
    case "TOPIC_NOT_FOUND":
      return "This topic no longer exists";
    default:
      return "The topic operation failed";
  }
}
