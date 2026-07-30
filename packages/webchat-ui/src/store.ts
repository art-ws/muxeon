// Pure panel state + reducer (§12.7) — all chat/dynamics logic lives here,
// DOM-free, so `bun test` covers it without a browser. Components stay thin.

import type { ChatRecord, MessagePhase, PanelEvent, PeerInfo } from "./types";

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
}

export const initialState: PanelState = { peers: [], threads: {}, phases: {} };

const EMPTY_THREAD: ChatThread = { records: [], loaded: false };

export const threadOf = (state: PanelState, peer: string): ChatThread =>
  state.threads[peer] ?? EMPTY_THREAD;

/** The chat partner of a record from the operator's point of view. */
export const peerOf = (record: ChatRecord, operatorish: (name: string) => boolean): string =>
  operatorish(record.from) ? record.to : record.from;

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
  page: { records: readonly ChatRecord[]; nextBefore?: string },
): PanelState {
  const thread = threadOf(state, peer);
  const known = new Set(thread.records.map((record) => record.id));
  const fresh = page.records.filter((record) => !known.has(record.id));
  return withThread(state, peer, {
    records: [...fresh, ...thread.records],
    loaded: true,
    ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
  });
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

export function selectPeer(state: PanelState, peer: string | undefined): PanelState {
  // undefined = no chat open (home/transport route, FR-60) — unread badges must
  // keep counting for every peer again.
  if (peer === undefined) {
    const { selected: _, ...rest } = state;
    return rest;
  }
  // selecting clears the unread badge locally; the server watermark moves via api.markRead
  return {
    ...state,
    selected: peer,
    peers: state.peers.map((info) => (info.name === peer ? { ...info, unread: 0 } : info)),
  };
}

/** An optimistic outbound record (echoed by WS too — the dedup absorbs it). */
export function applyOutgoing(state: PanelState, record: ChatRecord): PanelState {
  const next = withThread(state, record.to, appendRecord(threadOf(state, record.to), record));
  return { ...next, phases: { ...next.phases, [record.id]: "queued" } };
}

/** One WS event → state (§12.4). `isOperator` names the panel's own side. */
export function applyEvent(
  state: PanelState,
  event: PanelEvent,
  isOperator: (name: string) => boolean,
  now: number = Date.now(),
): PanelState {
  switch (event.type) {
    case "message": {
      const peer = peerOf(event.record, isOperator);
      const fromAgent = !isOperator(event.record.from);
      const next = withThread(state, peer, appendRecord(threadOf(state, peer), event.record));
      // a live inbound message bumps the unread badge unless the chat is open
      if (fromAgent && state.selected !== peer) {
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
    case "history-cleared": {
      // FR-84: the server dropped the pair's log — empty the thread in EVERY
      // tab (the clearing one included; it relies on this same push) and zero
      // the badge: nothing is left to be unread.
      const next = withThread(state, event.peer, { records: [], loaded: true });
      return {
        ...next,
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
          const { busySince: _, ...base } = info;
          const next = {
            ...base,
            status: event.status,
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
