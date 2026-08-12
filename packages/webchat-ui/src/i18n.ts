// UI languages (T114, FR-78). ENGLISH IS THE SOURCE: every string in the
// components is written in English and doubles as the translation KEY. A
// translation is a flat JSON dictionary (assets/i18n/<lang>.json, fetched
// lazily) mapping the English source string to its translation; anything
// missing — a key, the file, the whole language — falls back to the English
// original, so translations are strictly OPTIONAL. The choice persists in
// localStorage with the same discipline as prefs.ts: injectable storage,
// junk → default, blocked storage degrades silently.

export type Lang = "en" | "ru";

export const DEFAULT_LANG: Lang = "en";

/** The selector options (FR-78): code → its own native label. */
export const LANGS: readonly { readonly code: Lang; readonly label: string }[] = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
];

export type Messages = Readonly<Record<string, string>>;

/** A translate function: English source text in, display text out. */
export type Translate = (text: string) => string;

const KEY = "muxeon-pref:lang";

interface LangStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Anything that is not a known language code is the default (English). */
export function normalizeLang(value: unknown): Lang {
  return LANGS.some((lang) => lang.code === value) ? (value as Lang) : DEFAULT_LANG;
}

export function loadLang(storage: LangStorage = localStorage): Lang {
  try {
    return normalizeLang(storage.getItem(KEY));
  } catch {
    return DEFAULT_LANG; // storage blocked (private mode etc.)
  }
}

/** Best-effort persist — the session still gets the language either way. */
export function saveLang(lang: Lang, storage: LangStorage = localStorage): void {
  try {
    storage.setItem(KEY, lang);
  } catch {
    // not persisted — the session still shows the language
  }
}

/** Strict dictionary check: a plain object, string→non-empty-string entries
 *  pass, everything else is dropped (junk never breaks the UI). */
export function parseMessages(raw: unknown): Messages {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim() !== "") clean[key] = value;
  }
  return clean;
}

/** The translator over a (possibly absent) dictionary — English passes through. */
export function translator(messages: Messages | undefined): Translate {
  if (messages === undefined) return (text) => text;
  return (text) => messages[text] ?? text;
}
