// Broadcast target resolution (§15.4, FR-110) — the pure member-set logic behind
// the router's fan-out. A `to` naming a GROUP resolves to every agent in that group
// OR any transitive descendant group (hierarchical, §15.1); a `to` naming a TAG
// resolves to every agent carrying it (flat). Anything else resolves to null (a
// normal agent/operator recipient — the router's single-delivery path handles it).
//
// This module is deliberately dependency-free — it takes plain structural records,
// not the config types — so it stays trivially unit-testable and keeps @muxeon/config
// out of the orchestrator's dependency graph. The composition root (server bootstrap)
// feeds it `config.groups`/`config.agents` and hands the resulting resolver to the
// Router as `resolveBroadcast`.

export interface BroadcastGroup {
  readonly name: string;
  readonly parent?: string;
}

/**
 * A member candidate: an agent — or, since §17 (FR-130), a USER. Both carry the
 * same `{name, group?, tags?}` shape, and both are equal members of a group/tag,
 * so the composition root feeds this resolver `[...agents, ...users]`.
 */
export interface BroadcastAgent {
  readonly name: string;
  readonly group?: string;
  readonly tags?: readonly string[];
}

export interface BroadcastTarget {
  readonly kind: "group" | "tag";
  /** The resolved member agent names, in config order (deterministic, deduped). */
  readonly members: readonly string[];
}

/**
 * Builds the `resolveBroadcast(to)` function the Router uses to classify a `to`
 * (§15.4). Membership is precomputed once (config is fixed at boot, §7): every
 * group maps to its hierarchical member set, every tag to its carriers. The
 * returned function is a pure lookup — O(1) per route.
 */
export function buildBroadcastResolver(
  groups: readonly BroadcastGroup[],
  agents: readonly BroadcastAgent[],
): (to: string) => BroadcastTarget | null {
  // group → its direct child groups (for the transitive descendant walk).
  const childrenOf = new Map<string, string[]>();
  for (const group of groups) {
    if (group.parent === undefined) continue;
    const siblings = childrenOf.get(group.parent) ?? [];
    siblings.push(group.name);
    childrenOf.set(group.parent, siblings);
  }
  const descendantsInclusive = (root: string): Set<string> => {
    const out = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (out.has(cur)) continue; // the config validator forbids cycles, but stay safe
      out.add(cur);
      for (const child of childrenOf.get(cur) ?? []) stack.push(child);
    }
    return out;
  };

  // group name → member agents (this group + every descendant group).
  const groupMembers = new Map<string, string[]>();
  for (const group of groups) {
    const subtree = descendantsInclusive(group.name);
    const members = agents
      .filter((a) => a.group !== undefined && subtree.has(a.group))
      .map((a) => a.name);
    groupMembers.set(group.name, members);
  }

  // tag name → carrier agents (implicit namespace, union across agents).
  const tagMembers = new Map<string, string[]>();
  for (const agent of agents) {
    for (const tag of agent.tags ?? []) {
      const carriers = tagMembers.get(tag) ?? [];
      carriers.push(agent.name);
      tagMembers.set(tag, carriers);
    }
  }

  return (to: string): BroadcastTarget | null => {
    const group = groupMembers.get(to);
    if (group !== undefined) return { kind: "group", members: group };
    const tag = tagMembers.get(to);
    if (tag !== undefined) return { kind: "tag", members: tag };
    return null;
  };
}
