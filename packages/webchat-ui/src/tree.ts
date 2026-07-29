// The sidebar broadcast tree (§15, FR-106/FR-107) — a PURE builder, DOM-free so
// `bun test` covers the ordering/nesting without a browser. Groups form a forest
// (a group's `parent` names its parent; a groupless agent and a top-level group
// sit at the root); agents are leaves under their `group`. A collapsed group
// hides its whole subtree — child groups AND agent leaves. The output is a flat,
// depth-tagged list in render order; the expanded rows and the collapsed icon
// rail both consume THIS list, so they mirror 1:1 (same order, same collapse).
//
// Determinism (the rail depends on it): at every level the child GROUPS come
// first, then the agent LEAVES, each in the input `peers` order. Only real
// peers appear — an agent naming a `group` that no group peer declares falls
// back to the root (a dangling reference never hides the agent). A group cycle
// (parent chains that loop) is broken defensively: a group only nests under a
// parent that is itself reachable from a root, otherwise it surfaces at the root.

import { type PeerInfo, peerKind } from "./types";

/** One rendered tree row: a group header or an agent leaf, with its indent depth. */
export interface TreeRow {
  readonly kind: "group" | "agent";
  readonly name: string;
  /** Indentation level — 0 at the root, +1 per nesting. */
  readonly depth: number;
  /** The backing peer (a group carries members/parent, an agent its status). */
  readonly peer: PeerInfo;
}

/**
 * Build the ordered, depth-tagged rows of the sidebar tree.
 *
 * @param peers    the visible peers (agents + group/tag peers intermixed).
 * @param expanded the set of EXPANDED group names, or `undefined` ⇒ ALL groups
 *                 expanded (the fresh-tree default; matches prefs.ts).
 */
export function buildTree(
  peers: readonly PeerInfo[],
  expanded?: ReadonlySet<string>,
): readonly TreeRow[] {
  const groups = peers.filter((peer) => peerKind(peer) === "group");
  const agents = peers.filter((peer) => peerKind(peer) === "agent");
  const groupNames = new Set(groups.map((group) => group.name));

  // Child groups indexed by parent name; a parent that is not a real group peer
  // (dangling or a cycle) is treated as absent, so the child surfaces at the root.
  const rootGroups = groups.filter(
    (group) => group.parent === undefined || !groupNames.has(group.parent),
  );
  const childGroupsOf = (parent: string): readonly PeerInfo[] =>
    groups.filter((group) => group.parent === parent && group.parent !== group.name);

  // Agent leaves indexed by their group; an agent whose `group` is not a real
  // group peer is groupless (renders at the root).
  const agentsOf = (group: string | undefined): readonly PeerInfo[] =>
    agents.filter((agent) =>
      group === undefined
        ? agent.group === undefined || !groupNames.has(agent.group)
        : agent.group === group,
    );

  const isExpanded = (name: string): boolean => expanded === undefined || expanded.has(name);

  // Reachability from a root (independent of collapse): a group in a parent
  // cycle reaches no root and must be surfaced at the root itself, so neither it
  // nor its members silently vanish. Collapse hides descendants at RENDER time
  // (below) — it does not make them unreachable.
  const reachable = new Set<string>();
  const mark = (group: PeerInfo): void => {
    if (reachable.has(group.name)) return;
    reachable.add(group.name);
    for (const child of childGroupsOf(group.name)) mark(child);
  };
  for (const group of rootGroups) mark(group);
  const orphanGroups = groups.filter((group) => !reachable.has(group.name));

  const rows: TreeRow[] = [];
  const placed = new Set<string>(); // group names already rendered (cycle guard)
  const walkGroup = (group: PeerInfo, depth: number): void => {
    rows.push({ kind: "group", name: group.name, depth, peer: group });
    placed.add(group.name);
    if (!isExpanded(group.name)) return; // a collapsed group hides its subtree
    for (const child of childGroupsOf(group.name)) {
      if (!placed.has(child.name)) walkGroup(child, depth + 1);
    }
    for (const agent of agentsOf(group.name)) {
      rows.push({ kind: "agent", name: agent.name, depth: depth + 1, peer: agent });
    }
  };

  // Root level: top-level groups first, then the cycle-orphaned groups, then the
  // groupless agents — each in input order.
  for (const group of rootGroups) walkGroup(group, 0);
  for (const group of orphanGroups) {
    if (!placed.has(group.name)) walkGroup(group, 0);
  }
  for (const agent of agentsOf(undefined)) {
    rows.push({ kind: "agent", name: agent.name, depth: 0, peer: agent });
  }
  return rows;
}

/** The tag peers (§15, FR-107) — the flat "Tags" section under the tree, input order. */
export function tagPeers(peers: readonly PeerInfo[]): readonly PeerInfo[] {
  return peers.filter((peer) => peerKind(peer) === "tag");
}
