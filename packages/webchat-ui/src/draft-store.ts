// Composer draft persistence (T93, FR-69, §12.7): the typed-but-unsent text and
// the manually resized textarea height survive leaving the page — per peer, in
// localStorage. Same discipline as theme.ts: storage is injectable so the logic
// stays bun-testable without a DOM, junk parses to the empty draft, a blocked
// storage degrades silently (the session still works, nothing persists).
// Attachments are deliberately NOT persisted: their blob ids age out of the
// store (§5.4 GC), a restored chip could point at nothing.

export interface ComposerDraft {
  readonly text: string;
  /** Manual textarea height, px (the operator's resize drag); absent = auto rows. */
  readonly height?: number;
}

export const EMPTY_DRAFT: ComposerDraft = { text: "" };

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyOf = (peer: string): string => `teamai-draft:${peer}`;

/** Anything that is not a {text: string, height?: positive number} is empty. */
export function normalizeDraft(value: unknown): ComposerDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_DRAFT;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  const height =
    typeof record.height === "number" && Number.isFinite(record.height) && record.height > 0
      ? Math.round(record.height)
      : undefined;
  return { text, ...(height !== undefined ? { height } : {}) };
}

export function loadDraft(peer: string, storage: DraftStorage = localStorage): ComposerDraft {
  try {
    const raw = storage.getItem(keyOf(peer));
    if (raw === null) return EMPTY_DRAFT;
    return normalizeDraft(JSON.parse(raw));
  } catch {
    return EMPTY_DRAFT; // storage blocked or junk content — a fresh composer
  }
}

/** Best-effort persist; an EMPTY draft removes the key (no litter). */
export function saveDraft(
  peer: string,
  draft: ComposerDraft,
  storage: DraftStorage = localStorage,
): void {
  try {
    if (draft.text === "" && draft.height === undefined) {
      storage.removeItem(keyOf(peer));
      return;
    }
    storage.setItem(keyOf(peer), JSON.stringify(normalizeDraft(draft)));
  } catch {
    // not persisted — typing still works, the draft just won't survive the page
  }
}
