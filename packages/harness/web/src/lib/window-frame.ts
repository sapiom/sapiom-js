/**
 * Which window frame the SPA is rendering inside.
 *
 * The SAME bundle is served two ways: by `npx @sapiom/harness` into a plain
 * browser, and by the Electron app into a frameless macOS window. The desktop
 * host hands off its frame explicitly via `?frame=macos` on the load URL; a
 * browser never carries it. We do NOT sniff the OS — a mac *browser* is still
 * "web", because only the Electron window actually removes its title bar and
 * insets the traffic lights. Presence of the signal is the whole contract, so a
 * browser can never get the desktop-only chrome (a drag region that cannot
 * drag, a header padded for lights that are not there).
 */
export type AppFrame = "web" | "macos";

export function appFrameFromSearch(
  search = typeof window === "undefined" ? "" : window.location.search,
): AppFrame {
  return new URLSearchParams(search).get("frame") === "macos" ? "macos" : "web";
}
