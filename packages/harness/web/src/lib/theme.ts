import { DISPLAY_MODES, type DisplayMode } from "@shared/types";

export type Theme = "light" | "dark";
export type { DisplayMode };

/**
 * Where a choice made in this tab is cached. The authoritative copy lives in
 * `settings.json` (`HarnessSettings.displayMode`), because the desktop app
 * serves the SPA from a different ephemeral port on every launch and a new
 * port is a new origin — i.e. an empty localStorage. This key only has to
 * survive a reload on the same origin.
 *
 * Must match the inline script in web/index.html — that copy runs before any
 * JS module loads (avoids a flash of the wrong theme) and can't import this
 * one, so the key is duplicated rather than shared.
 */
const MODE_STORAGE_KEY = "sapiom-harness-display-mode";

/** The pre-display-mode key, still read once so an existing install keeps its
 *  light/dark choice. Never written. */
const LEGACY_THEME_STORAGE_KEY = "sapiom-harness-theme";

/** No stored preference → dark, matching the Studio's default. */
const DEFAULT_MODE: DisplayMode = "dark";

type Listener = (theme: Theme) => void;
type ModeListener = (mode: DisplayMode) => void;
const listeners = new Set<Listener>();
const modeListeners = new Set<ModeListener>();

/** A recognised display mode, or undefined — stored junk and values written by
 *  a newer build both fall through to the caller's fallback. */
export function normalizeDisplayMode(value: unknown): DisplayMode | undefined {
  return DISPLAY_MODES.find((mode) => mode === value);
}

/** The colour scheme a mode asks for. Pure: `prefersDark` is the OS answer. */
export function resolveTheme(mode: DisplayMode, prefersDark: boolean): Theme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

function darkQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

function systemPrefersDark(): boolean {
  return darkQuery()?.matches === true;
}

/**
 * The mode this page starts in, in resolution order:
 *   1. `data-display-mode` on `<html>` — the persisted setting, stamped into
 *      the served HTML by the server (src/server/static.ts) and therefore the
 *      only source available before the SPA has fetched anything;
 *   2. this origin's localStorage (dev server, plain browser);
 *   3. the pre-display-mode `theme` key;
 *   4. dark.
 */
export function getInitialDisplayMode(): DisplayMode {
  if (typeof document === "undefined") return DEFAULT_MODE;
  const injected = normalizeDisplayMode(document.documentElement.dataset.displayMode);
  if (injected) return injected;
  const stored = normalizeDisplayMode(window.localStorage.getItem(MODE_STORAGE_KEY));
  if (stored) return stored;
  const legacy = normalizeDisplayMode(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY));
  return legacy ?? DEFAULT_MODE;
}

let currentMode: DisplayMode = getInitialDisplayMode();
let current: Theme = resolveTheme(currentMode, systemPrefersDark());

export function getTheme(): Theme {
  return current;
}

export function getDisplayMode(): DisplayMode {
  return currentMode;
}

function paint(theme: Theme): void {
  if (current === theme) return;
  current = theme;
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  listeners.forEach((listener) => listener(theme));
}

type Persister = (mode: DisplayMode) => void;
let persister: Persister | null = null;

/**
 * Hands this module the way to persist a mode for the NEXT launch (App wires
 * it to `PATCH /api/settings`). Registered once rather than threaded as a prop
 * because there are two controls in different subtrees — the Settings panel
 * and the rail header's one-click toggle — and a choice that only one of them
 * saved is the bug this replaces. Pass null to unregister.
 */
export function registerDisplayModePersistence(next: Persister | null): void {
  persister = next;
}

/** Apply a mode to this page AND remember it for the next launch. */
export function setDisplayMode(mode: DisplayMode): void {
  applyDisplayMode(mode);
  persister?.(mode);
}

/**
 * Apply a display mode to this page and cache it in this origin's storage,
 * without persisting it server-side — the path for a mode that CAME from the
 * server (settings.json is already the source of that value).
 */
export function applyDisplayMode(mode: DisplayMode): void {
  currentMode = mode;
  if (typeof document !== "undefined") document.documentElement.dataset.displayMode = mode;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Private mode / quota — the server copy is what actually persists.
    }
  }
  paint(resolveTheme(mode, systemPrefersDark()));
  modeListeners.forEach((listener) => listener(mode));
}

/** Pin the opposite of what's on screen — the header's one-click affordance,
 *  which always lands on an explicit light or dark (never "system"). */
export function toggleTheme(): void {
  setDisplayMode(current === "dark" ? "light" : "dark");
}

/** For components (e.g. the terminal) that need to react to a live theme change. Returns an unsubscribe function. */
export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Same, for the setting itself — "system" and the theme it currently resolves
 *  to are different facts, and the Settings panel shows the former. */
export function subscribeDisplayMode(listener: ModeListener): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

// "System" means *keeps following* the OS, not "read it once at startup", so
// the app must repaint when the user flips their OS appearance while it runs.
darkQuery()?.addEventListener("change", (event) => {
  if (currentMode === "system") paint(event.matches ? "dark" : "light");
});
