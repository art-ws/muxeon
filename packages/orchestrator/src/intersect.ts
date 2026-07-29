// Selector-intersection for operator slash-commands (§15.8, FR-115, invariant
// §10.18). A command target is a SET of selectors — each a group, a tag, or a
// plain agent — and the effective recipients are the INTERSECTION of the agent
// sets each selector resolves to. This is distinct from message broadcast
// (§15.4, a UNION fanned out in the router): commands act per-agent-console and
// fan out OUTSIDE the router (control-lane), so this stays a pure, router-free
// helper the admin layer calls before dispatching.
//
// Selector resolution reuses the broadcast resolver (group → hierarchical
// members, tag → carriers); a plain known agent resolves to the singleton
// { agent }. A selector that is neither group, tag, nor agent is UNKNOWN — the
// caller rejects the whole request (UNKNOWN_SELECTOR), it is NOT a silent
// empty result.

import type { BroadcastTarget } from "./broadcast";

export interface SelectorIntersection {
  /**
   * The intersection of every selector's resolved agents — agents present in
   * ALL selectors. Deterministic order (the first selector's member order),
   * deduped. Empty when the sets don't overlap (a valid result, not an error).
   */
  readonly agents: readonly string[];
  /** Selectors that resolve to nothing known (not a group/tag/agent). */
  readonly unknown: readonly string[];
}

/**
 * Resolve `selectors` to the intersection of their agent sets (§15.8).
 *
 * @param selectors     the command's target selectors (groups/tags/agents)
 * @param resolveBroadcast  from {@link buildBroadcastResolver} — group/tag → members, else null
 * @param isAgent       whether a name is a known agent (a null broadcast-resolve
 *                      that IS an agent → singleton; otherwise → unknown)
 */
export function intersectSelectors(
  selectors: readonly string[],
  resolveBroadcast: (to: string) => BroadcastTarget | null,
  isAgent: (name: string) => boolean,
): SelectorIntersection {
  if (selectors.length === 0) return { agents: [], unknown: [] };

  const unknown: string[] = [];
  const memberSets: Set<string>[] = [];
  let firstOrder: readonly string[] = [];

  selectors.forEach((sel, i) => {
    const target = resolveBroadcast(sel);
    let members: readonly string[];
    if (target !== null)
      members = target.members; // group or tag
    else if (isAgent(sel))
      members = [sel]; // plain agent → singleton
    else {
      unknown.push(sel);
      members = [];
    }
    memberSets.push(new Set(members));
    if (i === 0) firstOrder = members;
  });

  // intersection in the first selector's order, deduped
  const seen = new Set<string>();
  const agents: string[] = [];
  for (const name of firstOrder) {
    if (seen.has(name)) continue;
    if (memberSets.every((set) => set.has(name))) {
      agents.push(name);
      seen.add(name);
    }
  }
  return { agents, unknown };
}
