export type Theme = "light" | "dark";

/**
 * Must match the inline script in web/index.html — that copy runs before any
 * JS module loads (avoids a flash of the wrong theme) and can't import this
 * one, so the storage key is duplicated rather than shared.
 */
const STORAGE_KEY = "sapiom-harness-theme";

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/** No stored preference → dark, matching the Studio's default.
 *  The toggle and any stored choice still win. */
export function getInitialTheme(): Theme {
  const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

let current: Theme = getInitialTheme();

export function getTheme(): Theme {
  return current;
}

export function applyTheme(theme: Theme): void {
  current = theme;
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
  listeners.forEach((listener) => listener(theme));
}

export function toggleTheme(): void {
  applyTheme(current === "dark" ? "light" : "dark");
}

/** For components (e.g. the terminal) that need to react to a live theme change. Returns an unsubscribe function. */
export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
