/**
 * Whether the app window currently holds focus, published to CSS as
 * `data-window-focused` on :root.
 *
 * The frameless macOS window hides its traffic lights whenever it loses focus
 * (and in full screen), which empties the clearance the rail toggle sits after
 * — the toggle then reads as a stray glyph in a gap rather than the window
 * control it is. Blurred chrome is the only state that needs the toggle to
 * carry its own surface, so the state has to reach CSS.
 *
 * `document.hasFocus()` seeds it: the SPA can mount into an already-blurred
 * window (the desktop host restores a background window), and focus/blur only
 * fire on change.
 */
export function observeWindowFocus(
  root: HTMLElement = document.documentElement,
  win: Window = window,
): () => void {
  const set = (focused: boolean): void => {
    root.dataset.windowFocused = focused ? "true" : "false";
  };

  set(win.document.hasFocus());
  const onFocus = (): void => set(true);
  const onBlur = (): void => set(false);
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);

  return () => {
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("blur", onBlur);
  };
}
