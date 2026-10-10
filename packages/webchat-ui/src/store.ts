// Pure panel state + reducer (§12.7) — all chat/dynamics logic lives here,
// DOM-free, so `bun test` covers it without a browser. Components stay thin.

import { topicThreadKey } from "./topics";
import type {
  ChatRecord,
  MessagePhase,
  PanelEvent,
  PeerInfo,
  ReactionView,
  TopicList,
} from "./types";

export interface ChatThread {
  /** Chronological records (oldest → newest), §12.3 order. */
  readonly records: readonly ChatRecord[];
  /** Cursor for older history; undefined = reached the start. */
  readonly nextBefore?: string;
  /** Whether the first page was loaded. */
  readonly loaded: boolean;
}

export interface PanelState {
  readonly peers: readonly PeerInfo[];
  readonly selected?: string;
  readonly threads: Readonly<Record<string, ChatThread>>;
  /** Lifecycle of outgoing messages (§12.7): id → phase. */
  readonly phases: Readonly<Record<string, MessagePhase>>;
  /**
   * Reactions by MESSAGE id (§19.5, FR-162) — one flat map, not a per-thread one:
   * message ids are unique across pairs, and the self-chat shows the very same
   * record as its pair thread does (§17.7), so one entry serves both views.
   */
  readonly reactions: Readonly<Record<string, readonly ReactionView[]>>;
  /** Topic trees of agent chats by peer (§23.3) — the GET/push snapshot. */
  readonly topics: Readonly<Record<string, TopicList>>;
  /**
   * The topic on screen for `selected` (§23.4); undefined = the whole log (topics
   * off, §23.6, or a chat that has no topics). Decides which arrivals are "seen".
   */
  readonly openTopic?: string;
}

export const initialState: PanelState = {
  peers: [],
  threads: {},
  phases: {},
  reactions: {},
  topics: {},
};

const EMPTY_THREAD: ChatThread = { records: [], loaded: false };

export const threadOf = (state: PanelState, peer: string): ChatThread =>
  state.threads[peer] ?? EMPTY_THREAD;

const NO_REACTIONS: readonly ReactionView[] = [];

/** A message's reactions (§19.5) — empty when it has none. */
export const reactionsOf = (state: PanelState, messageId: string): readonly ReactionView[] =>
  state.reactions[messageId] ?? NO_REACTIONS;

/**
 * Fold one message's new state in (§19.5): the server always sends the WHOLE
 * folded list, so this replaces rather than merges — and an empty list DROPS the
 * entry instead of keeping an empty array around.
 */
export function applyReactions(
  state: PanelState,
  messageId: string,
  reactions: readonly ReactionView[],
): PanelState {
  if (reactions.length === 0) {
    if (state.reactions[messageId] === undefined) return state;
    const { [messageId]: _gone, ...rest } = state.reactions;
    return { ...state, reactions: rest };
  }
  return { ...state, reactions: { ...state.reactions, [messageId]: reactions } };
}

/**
 * The chat partner of a record from the operator's point of view. `self` — the
 * logged-in user's name (§17.7) — decides it outright when known: in users mode
 * the viewer's OWN name is also a peer row (the self-chat), so the "whoever is
 * not a peer is us" heuristic would file every outgoing message under the
 * sender instead of the recipient. Without it (legacy operator, §17.9) the
 * heuristic still holds.
 */
export const peerOf = (
  record: ChatRecord,
  operatorish: (name: string) => boolean,
  self?: string,
): string => {
  if (self !== undefined) return record.from === self ? record.to : record.from;
  return operatorish(record.from) ? record.to : record.from;
};

function withThread(state: PanelState, peer: string, thread: ChatThread): PanelState {
  return { ...state, threads: { ...state.threads, [peer]: thread } };
}

/** Dedup-by-id append keeping chronology — WS pushes can race history loads (§10.9). */
function appendRecord(thread: ChatThread, record: ChatRecord): ChatThread {
  if (thread.records.some((existing) => existing.id === record.id)) return thread;
  return { ...thread, records: [...thread.records, record] };
}

/** Prepend an older page (cursor paging §12.4), deduped against what is shown. */
export function applyHistoryPage(
  state: PanelState,
  peer: string,
  page: {
    records: readonly ChatRecord[];
    nextBefore?: string;
    reactions?: Readonly<Record<string, readonly ReactionView[]>>;
  },
): PanelState {
  const thread = threadOf(state, peer);
  const known = new Set(thread.records.map((record) => record.id));
  const fresh = page.records.filter((record) => !known.has(record.id));
  const next = withThread(state, peer, {
    records: [...fresh, ...thread.records],
    loaded: true,
    ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
  });
  // The page carries the reactions of ITS records (§19.5); ids outside it keep
  // whatever they had (an older page never invalidates a newer badge).
  if (page.reactions === undefined) return next;
  return { ...next, reactions: { ...next.reactions, ...page.reactions } };
}

export function applyPeers(
  state: PanelState,
  peers: readonly PeerInfo[],
  now: number = Date.now(),
): PanelState {
  // busySince is client-observed (FR-63): a peer already busy keeps its stamp
  // across refetches; a peer first seen busy starts counting from this fetch.
  return {
    ...state,
    peers: peers.map((info) => {
      if (info.status !== "busy") return info;
      const previous = state.peers.find((known) => known.name === info.name);
      const since =
        previous?.status === "busy" && previous.busySince !== undefined ? previous.busySince : now;
      return { ...info, busySince: since };
    }),
  };
}

export function selectPeer(
  state: PanelState,
  peer: string | undefined,
  topicId?: string,
): PanelState {
  // undefined = no chat open (home/transport route, FR-60) — unread badges must
  // keep counting for every peer again.
  if (peer === undefined) {
    const { selected: _, openTopic: __, ...rest } = state;
    return rest;
  }
  if (topicId !== undefined) {
    // A topic opens (§23.3): only ITS unread is read — the badge keeps the others.
    const { openTopic: _, ...rest } = state;
    return settleOpenTopic({ ...rest, selected: peer, openTopic: topicId });
  }
  // selecting clears the unread badge locally; the server watermark moves via api.markRead
  const { openTopic: _, ...rest } = state;
  return {
    ...rest,
    selected: peer,
    peers: state.peers.map((info) => (info.name === peer ? { ...info, unread: 0 } : info)),
  };
}

/**
 * With a topic open, its unread is read and the peer's badge is the sum of the
 * OTHER topics (§23.3) — recomputed from the tree whenever it is known.
 */
function settleOpenTopic(state: PanelState): PanelState {
  const peer = state.selected;
  const open = state.openTopic;
  if (peer === undefined || open === undefined) return state;
  const list = state.topics[peer];
  if (list === undefined) return state;
  const topics = list.topics.map((topic) =>
    topic.id === open && topic.unread !== 0 ? { ...topic, unread: 0 } : topic,
  );
  const unread = topics.reduce((sum, topic) => sum + topic.unread, 0);
  return {
    ...state,
    topics: { ...state.topics, [peer]: { ...list, topics } },
    peers: state.peers.map((info) => (info.name === peer ? { ...info, unread } : info)),
  };
}

/** A pair's topic tree arrived (GET or the `topics-changed` push, §23.3). */
export function applyTopicList(state: PanelState, peer: string, list: TopicList): PanelState {
  const next = { ...state, topics: { ...state.topics, [peer]: list } };
  return peer === state.selected ? settleOpenTopic(next) : next;
}

/** Remove exactly these records from every feed of the pair and from the self feed. */
function withoutRecords(
  state: PanelState,
  peer: string,
  ids: ReadonlySet<string>,
  self?: string,
): PanelState {
  const threads: Record<string, ChatThread> = { ...state.threads };
  for (const [key, thread] of Object.entries(state.threads)) {
    const ofPeer = key === peer || key.startsWith(`${peer}\u0001`) || key === self;
    if (!ofPeer || !thread.records.some((record) => ids.has(record.id))) continue;
    threads[key] = { ...thread, records: thread.records.filter((record) => !ids.has(record.id)) };
  }
  const reactions = { ...state.reactions };
  for (const id of ids) delete reactions[id];
  return { ...state, threads, reactions };
}

/**
 * The self-chat (§17.7, FR-128) is the AGGREGATE of everything this user says
 * and hears: a record belongs to its pair thread AND to the self thread. The
 * server projects the same view into the history page; live records mirror
 * themselves here so an open panel matches a reloaded one. `self` absent (a
 * legacy operator, §17.9 — no self row) ⇒ the pair thread alone.
 */
function withMirror(
  state: PanelState,
  peer: string,
  record: ChatRecord,
  self?: string,
): PanelState {
  const next = withThread(state, peer, appendRecord(threadOf(state, peer), record));
  if (self === undefined || peer === self) return next;
  return withThread(next, self, appendRecord(threadOf(next, self), record));
}

/** Also file a record under its topic feed (§23.3), when it has one. */
function withTopic(
  state: PanelState,
  peer: string,
  record: ChatRecord,
  topicId: string | undefined,
): PanelState {
  if (topicId === undefined) return state;
  const key = topicThreadKey(peer, topicId);
  return withThread(state, key, appendRecord(threadOf(state, key), record));
}

/** An optimistic outbound record (echoed by WS too — the dedup absorbs it). */
export function applyOutgoing(
  state: PanelState,
  record: ChatRecord,
  self?: string,
  topicId?: string,
): PanelState {
  const next = withTopic(withMirror(state, record.to, record, self), record.to, record, topicId);
  return { ...next, phases: { ...next.phases, [record.id]: "queued" } };
}

/** One WS event → state (§12.4). `isOperator` names the panel's own side. */
export function applyEvent(
  state: PanelState,
  event: PanelEvent,
  isOperator: (name: string) => boolean,
  options: { now?: number; self?: string } = {},
): PanelState {
  const now = options.now ?? Date.now();
  switch (event.type) {
    case "message": {
      const self = options.self;
      const peer = peerOf(event.record, isOperator, self);
      // "not written by us" — a note to self (§17.7) is ours, so it raises no badge
      const fromAgent =
        self !== undefined ? event.record.from !== self : !isOperator(event.record.from);
      const topicId = event.topicId;
      let next = withTopic(
        withMirror(state, peer, event.record, self),
        peer,
        event.record,
        topicId,
      );
      // "Seen" = this chat is open AND (no topic is open — the whole log is on
      // screen — or it is the arrival's own topic, §23.3).
      const seen =
        state.selected === peer && (state.openTopic === undefined || state.openTopic === topicId);
      const list = next.topics[peer];
      if (fromAgent && !seen && topicId !== undefined && list !== undefined) {
        next = {
          ...next,
          topics: {
            ...next.topics,
            [peer]: {
              ...list,
              topics: list.topics.map((topic) =>
                topic.id === topicId ? { ...topic, unread: topic.unread + 1 } : topic,
              ),
            },
          },
        };
      }
      // a live inbound message bumps the unread badge unless it is seen — on the
      // PAIR row only: the self row mirrors every chat, and counting there too
      // would double every badge in the sidebar.
      if (fromAgent && !seen) {
        return {
          ...next,
          peers: next.peers.map((info) =>
            info.name === peer ? { ...info, unread: info.unread + 1 } : info,
          ),
        };
      }
      return next;
    }
    case "ack":
      return { ...state, phases: { ...state.phases, [event.id]: "queued" } };
    case "reaction":
      // Live badge update (§19.5): every tab of this user, including the one that
      // placed it — one mechanism, no local guesswork (the FR-84 clear-push rule).
      return applyReactions(state, event.messageId, event.reactions);
    case "topics-changed":
      return applyTopicList(state, event.peer, {
        topics: event.topics,
        defaultId: event.defaultId,
      });
    case "history-cleared": {
      // A topic delete/clear (§23.3) names exactly what left: those records go
      // from every feed of the pair — the whole log, the topic feeds, the self
      // feed — and nothing else does.
      if (event.ids !== undefined) {
        return withoutRecords(state, event.peer, new Set(event.ids), options.self);
      }
      // FR-84: the server dropped the pair's log — empty the thread in EVERY
      // tab (the clearing one included; it relies on this same push) and zero
      // the badge: nothing is left to be unread. Its topic feeds empty too (§23.1).
      const cleared = threadOf(state, event.peer).records;
      const emptied = Object.fromEntries(
        Object.keys(state.threads)
          .filter((key) => key.startsWith(`${event.peer}\u0001`))
          .map((key) => [key, { records: [], loaded: true }]),
      );
      const next = withThread({ ...state, threads: { ...state.threads, ...emptied } }, event.peer, {
        records: [],
        loaded: true,
      });
      // The sidecar went with the log (§19.4) — drop the badges of those records too.
      const reactions = { ...next.reactions };
      for (const record of cleared) delete reactions[record.id];
      return {
        ...next,
        reactions,
        peers: next.peers.map((info) => (info.name === event.peer ? { ...info, unread: 0 } : info)),
      };
    }
    case "queue-progress":
      return { ...state, phases: { ...state.phases, [event.id]: event.phase } };
    case "status":
      return {
        ...state,
        peers: state.peers.map((info) => {
          if (info.name !== event.peer) return info;
          const { busySince: _, reason: staleReason, ...base } = info;
          const next = {
            ...base,
            status: event.status ?? null,
            queueDepth: event.queueDepth,
            // pause (§16, FR-120) and the rendezvous / WIP markers (FR-104/FR-105)
            // — normalize absent ⇒ false
            paused: event.paused ?? false,
            atWipLimit: event.atWipLimit ?? false,
            waiting: event.waiting ?? false,
            awaited: event.awaited ?? false,
            // presence of a user peer (§17.5, FR-133) — kept as-is when the event
            // carries none (an agent row, or a pre-§17 server)
            ...(event.presence !== undefined ? { presence: event.presence } : {}),
            // federated peers (§18.4, FR-150): `link` rides every fed frame; a fed
            // frame WITHOUT a reason means the value became real — the stale
            // `unknown` cause is dropped, a local frame keeps whatever was there
            ...(event.link !== undefined ? { link: event.link } : {}),
            ...(event.reason !== undefined
              ? { reason: event.reason }
              : event.link === undefined && staleReason !== undefined
                ? { reason: staleReason }
                : {}),
          };
          // the busy EDGE stamps the timer (FR-63); staying busy keeps it,
          // leaving busy drops it — the header timer disappears with the status
          if (event.status !== "busy") return next;
          return {
            ...next,
            busySince:
              info.status === "busy" && info.busySince !== undefined ? info.busySince : now,
          };
        }),
      };
    default:
      return state;
  }
}
