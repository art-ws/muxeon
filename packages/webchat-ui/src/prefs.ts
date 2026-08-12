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

export type BoolPref =
  | "collapsed"
  | "follow"
  | "transport"
  | "raw"
  | "tags-collapsed"
  | "servers-collapsed"
  // Sidebar layout (§15): ON = the classic FLAT agent list (no groups/tags); OFF
  // (the default) = the group tree + Tags section. Persisted (FR-72).
  | "flat-peers"
  // Token-usage display: ON (the default) shows the per-agent token meter in the
  // chat header; OFF hides it for a lighter interface. Persisted (FR-72).
  | "show-tokens";

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
