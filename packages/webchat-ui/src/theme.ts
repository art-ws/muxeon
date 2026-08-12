// Theme switching (§12.7, FR-59): LIGHT is the default; the choice persists in
// localStorage and applies as <html data-theme="...">, which styles.css keys
// on. Storage/root are injectable so the logic stays bun-testable without a DOM;
// a broken/blocked localStorage degrades to the default, never to a crash.

export type Theme = "light" | "dark";

export const DEFAULT_THEME: Theme = "light";

const STORAGE_KEY = "muxeon-theme";

/** Anything that is not exactly "dark" is the default (light). */
export function normalizeTheme(value: unknown): Theme {
  return value === "dark" ? "dark" : DEFAULT_THEME;
}

export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ThemeRoot {
  readonly dataset: { theme?: string };
}

export function loadTheme(storage: ThemeStorage = localStorage): Theme {
  try {
    return normalizeTheme(storage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME; // storage blocked (private mode etc.)
  }
}

/** Sets <html data-theme> and persists the choice (best-effort). */
export function applyTheme(
  theme: Theme,
  root: ThemeRoot = document.documentElement,
  storage: ThemeStorage = localStorage,
): void {
  root.dataset.theme = theme;
  try {
    storage.setItem(STORAGE_KEY, theme);
  } catch {
    // not persisted — the session still gets the theme
  }
}
