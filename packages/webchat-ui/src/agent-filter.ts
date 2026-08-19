// The sidebar's agent filter (§12.7, FR-176/FR-177, T290 — operator request):
// the panel above the peer list, a name field plus an all/online switch. The
// rules live here, pure and DOM-free, so `bun test` covers what disappears from
// the sidebar without a browser — `PeerList` only renders what they keep.
//
// The filter speaks about PARTICIPANTS — an agent, a person (§17.7), a federated
// actor (§18.4): things with a name and a live state. Groups and tags (§15) have
// neither: they are input-only broadcast targets, so an active filter drops the
// Tags section outright and keeps a group header only while a matching member
// still hangs under it — a search must not print empty folders.

import { chatSurface } from "./peer-surface";
import { type PeerInfo, peerKind } from "./types";

export interface AgentFilter {
  /** The name/title needle; blank ⇒ no name filter. */
  readonly query: string;
  /** Keep only what is live right now — the "Online" side of the switch. */
  readonly onlineOnly: boolean;
}

/** The resting state: everything shows, exactly as before the panel existed. */
export const NO_FILTER: AgentFilter = { query: "", onlineOnly: false };

/** Is anything actually being filtered? A neutral filter must change nothing. */
export const filterActive = (filter: AgentFilter): boolean =>
  filter.query.trim() !== "" || filter.onlineOnly;

/** The rows the filter is about — a group/tag row is not one of them. */
export const isParticipant = (peer: PeerInfo): boolean => {
  const kind = peerKind(peer);
  return kind === "agent" || kind === "user";
};

/**
 * Live right now: an agent's session answers it (idle/busy — yes, down — no), a
 * person's presence does (FR-133). `unknown` — a federated peer behind a dead
 * link (§18.4) — is NOT online: the panel never upgrades "not known" into a
 * state. `paused` (§16) is orthogonal — a paused agent is still up, and the
 * operator who paused it is the last person who should lose sight of it.
 */
export function isOnline(peer: PeerInfo): boolean {
  if (chatSurface(peer) === "person") return peer.presence === "online";
  return peer.status === "idle" || peer.status === "busy";
}

/**
 * Case-insensitive substring over the name AND the configured label (FR-156):
 * the sidebar prints the title, so typing what is on screen must find the row,
 * and the name stays searchable because it is the address one greps by.
 */
export function matchesName(peer: PeerInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return `${peer.name}\n${peer.title ?? ""}`.toLowerCase().includes(needle);
}

/** Both halves of the panel, ANDed — the same combination rule as FR-71. */
export const matchesFilter = (peer: PeerInfo, filter: AgentFilter): boolean =>
  matchesName(peer, filter.query) && (!filter.onlineOnly || isOnline(peer));

/**
 * The peers the sidebar keeps. An inactive filter returns the input UNCHANGED —
 * the tree, the Tags and the Servers sections render exactly as they did. An
 * active one keeps the matching participants plus the group headers on their
 * ancestor chain, so a match nested three groups deep stays reachable.
 */
export function filterPeers(peers: readonly PeerInfo[], filter: AgentFilter): readonly PeerInfo[] {
  if (!filterActive(filter)) return peers;
  const kept = new Set(
    peers.filter((peer) => isParticipant(peer) && matchesFilter(peer, filter)).map((p) => p.name),
  );
  const groups = new Map(
    peers.filter((peer) => peerKind(peer) === "group").map((group) => [group.name, group]),
  );
  // Walk up from every match; a dangling parent or a group cycle just stops the
  // walk (tree.ts is defensive about both — this must not out-loop it).
  const keptGroups = new Set<string>();
  for (const peer of peers) {
    if (!kept.has(peer.name)) continue;
    let name = peer.group;
    while (name !== undefined && !keptGroups.has(name)) {
      const group = groups.get(name);
      if (group === undefined) break;
      keptGroups.add(name);
      name = group.parent;
    }
  }
  return peers.filter((peer) =>
    isParticipant(peer) ? kept.has(peer.name) : keptGroups.has(peer.name),
  );
}

/** How many participants a list holds — the panel's "N of M" counter. */
export const participantCount = (peers: readonly PeerInfo[]): number =>
  peers.filter(isParticipant).length;
