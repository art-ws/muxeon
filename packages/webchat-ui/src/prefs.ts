// UI preferences (T98, FR-72): the boolean panel switches — sidebar collapsed
// (FR-68), auto-scroll (FR-62) and the sidebar Transport entry (T115) —
// persist in localStorage and survive a page reload, completing the set with
// the theme (FR-59, theme.ts). Same discipline: injectable storage so the
// logic stays bun-testable without a DOM, junk falls back to the default, a
// blocked storage degrades silently.
//
// The sidebar tree (§15) adds one more boolean — the "Tags" section collapse —
// plus a JSON set: the EXPANDED group names (loadExpandedGroups/saveExpandedGroups).
// Absent/junk ⇒ "undefined", which the tree treats as "every group expanded".
//
// The agent filter itself (§12.7, FR-176) is the third shape: a JSON record of
// the needle and the all/online side (loadAgentFilter/saveAgentFilter).

import { type AgentFilter, NO_FILTER } from "./agent-filter";

export type BoolPref =
  | "collapsed"
  | "follow"
  | "transport"
  | "tags-collapsed"
  | "servers-collapsed"
  // Sidebar layout (§15): ON = the classic FLAT agent list (no groups/tags); OFF
  // (the default) = the group tree + Tags section. Persisted (FR-72).
  | "flat-peers"
  // Token-usage display: ON (the default) shows the per-agent token meter in the
  // chat header; OFF hides it for a lighter interface. Persisted (FR-72).
  | "show-tokens"
  // The sidebar's agent-filter panel (§12.7, FR-176): ON prints the name field +
  // all/online switch at the top of the sidebar; OFF is the default (T291) — a
  // fresh browser gets the sidebar it always had. This is the panel's VISIBILITY;
  // what it holds persists separately (loadAgentFilter, below).
  | "agent-filter";

interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const keyOf = (pref: BoolPref): string => `muxeon-pref:${pref}`;

/** Only the exact strings "true"/"false" count; anything else = the default. */
export function loadPref(
  pref: BoolPref,
  fallback: boolean,
  storage: PrefStorage = localStorage,
): boolean {
  try {
    const raw = storage.getItem(keyOf(pref));
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fallback;
  } catch {
    return fallback; // storage blocked (private mode etc.)
  }
}

/** Best-effort persist — the session still gets the switch either way. */
export function savePref(
  pref: BoolPref,
  value: boolean,
  storage: PrefStorage = localStorage,
): void {
  try {
    storage.setItem(keyOf(pref), String(value));
  } catch {
    // not persisted — the toggle still works for the session
  }
}

const EXPANDED_KEY = "muxeon-pref:tree-expanded";

/**
 * The EXPANDED group names of the sidebar tree (§15). Persisted as a JSON array
 * of strings; anything else — a missing key, junk JSON, a non-string element,
 * a blocked storage — yields `undefined`, which the caller reads as "no record
 * yet ⇒ treat every group as expanded" (the default state of a fresh tree).
 */
export function loadExpandedGroups(storage: PrefStorage = localStorage): Set<string> | undefined {
  try {
    const raw = storage.getItem(EXPANDED_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === "string")) {
      return undefined;
    }
    return new Set(parsed);
  } catch {
    return undefined; // junk JSON or blocked storage (private mode etc.)
  }
}

/** Best-effort persist of the expanded-group set — the session works either way. */
export function saveExpandedGroups(
  expanded: ReadonlySet<string>,
  storage: PrefStorage = localStorage,
): void {
  try {
    storage.setItem(EXPANDED_KEY, JSON.stringify([...expanded].sort()));
  } catch {
    // not persisted — the tree still expands/collapses for the session
  }
}

const FILTER_KEY = "muxeon-pref:agent-filter-state";

/**
 * What the sidebar's filter panel holds (§12.7, FR-176, T313 — operator request):
 * the typed needle and the all/online side, restored on reload like every other
 * panel switch (FR-72).
 *
 * The old refusal to persist this — "a filter surviving a reload would silently
 * shorten the sidebar" — was aimed at a filter that could act while INVISIBLE.
 * That cannot happen: the filter applies only while its panel is on screen, and
 * the panel's own visibility is a pref too, so a restored filter always comes
 * back WITH the field, the lit side and the "N of M" counter that explain the
 * shortened list.
 *
 * A half-readable record is not half-restored: anything unparseable, a non-object
 * or a non-string needle yields the resting filter, because a partly-restored
 * filter is exactly the state nobody can account for on screen.
 */
export function loadAgentFilter(storage: PrefStorage = localStorage): AgentFilter {
  try {
    const raw = storage.getItem(FILTER_KEY);
    if (raw === null) return NO_FILTER;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return NO_FILTER;
    const { query, onlineOnly } = parsed as { query?: unknown; onlineOnly?: unknown };
    if (typeof query !== "string" || typeof onlineOnly !== "boolean") return NO_FILTER;
    return { query, onlineOnly };
  } catch {
    return NO_FILTER; // junk JSON or blocked storage (private mode etc.)
  }
}

/** Best-effort persist of the filter — the session still filters either way. */
export function saveAgentFilter(filter: AgentFilter, storage: PrefStorage = localStorage): void {
  try {
    const record = { query: filter.query, onlineOnly: filter.onlineOnly };
    storage.setItem(FILTER_KEY, JSON.stringify(record));
  } catch {
    // not persisted — the panel still filters for the session
  }
}
