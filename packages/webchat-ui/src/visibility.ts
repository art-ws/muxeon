// Agent visibility filter (T110, FR-76): the settings page lets the operator
// show ALL agents in the sidebar (the default) or only a hand-picked set. The
// choice persists in localStorage. Same discipline as prefs.ts: injectable
// storage so the logic stays bun-testable without a DOM, junk falls back to
// the default ("all"), a blocked storage degrades silently.

export type Visibility = {
  readonly mode: "all" | "selected";
  readonly selected: ReadonlySet<string>;
};

export const SHOW_ALL: Visibility = { mode: "all", selected: new Set() };

const KEY = "teamai-pref:visible-agents";

interface VisStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Strict shape check: {"mode":"all"|"selected","selected":string[]} or bust. */
export function loadVisibility(storage: VisStorage = localStorage): Visibility {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return SHOW_ALL;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return SHOW_ALL;
    const { mode, selected } = parsed as { mode?: unknown; selected?: unknown };
    if (mode !== "all" && mode !== "selected") return SHOW_ALL;
    if (!Array.isArray(selected) || !selected.every((name) => typeof name === "string")) {
      return SHOW_ALL;
    }
    return { mode, selected: new Set(selected) };
  } catch {
    return SHOW_ALL; // junk JSON or blocked storage (private mode etc.)
  }
}

/** Best-effort persist — the session still gets the filter either way. */
export function saveVisibility(visibility: Visibility, storage: VisStorage = localStorage): void {
  try {
    storage.setItem(
      KEY,
      JSON.stringify({ mode: visibility.mode, selected: [...visibility.selected].sort() }),
    );
  } catch {
    // not persisted — the filter still works for the session
  }
}

/** The sidebar list under the filter: "all" passes through, else the picks. */
export function visiblePeers<T extends { readonly name: string }>(
  peers: readonly T[],
  visibility: Visibility,
): readonly T[] {
  if (visibility.mode === "all") return peers;
  return peers.filter((peer) => visibility.selected.has(peer.name));
}

/** Immutable check/uncheck of one agent (the settings checklist). */
export function toggleAgent(visibility: Visibility, name: string): Visibility {
  const selected = new Set(visibility.selected);
  if (selected.has(name)) selected.delete(name);
  else selected.add(name);
  return { mode: visibility.mode, selected };
}

/** Flip between "show all" and "only selected" keeping the picks. */
export function setMode(visibility: Visibility, mode: Visibility["mode"]): Visibility {
  return { mode, selected: visibility.selected };
}
