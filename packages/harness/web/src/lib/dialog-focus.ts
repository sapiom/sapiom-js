/**
 * The pure half of a dialog's focus containment.
 *
 * Everything here is arithmetic over an ORDERED LIST, with no DOM in it, so the
 * rule a trap actually enforces can be tested in the Node runner the SPA's unit
 * tier uses (see vitest.config.ts: React components are covered by the
 * Playwright tier, framework-free logic by this one). The DOM half — reading
 * the list, moving focus, restoring it — lives in `use-dialog-behavior.ts`.
 */

/**
 * What counts as reachable by Tab inside a dialog.
 *
 * `[tabindex]:not([tabindex="-1"])` is included so a consumer can hand the trap
 * a programmatically-focusable region; disabled controls and `hidden` inputs are
 * excluded because the browser skips them and a trap that disagreed with the
 * browser would strand focus on an element Tab cannot leave.
 */
export const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Where Tab should land, or `null` to let the browser do it.
 *
 * A trap is only ever needed at the two ENDS of the list: everywhere else the
 * browser's own order is already correct, and re-implementing it is how traps
 * start disagreeing with the sequence a screen reader announces. Returning
 * `null` for the interior is therefore the point, not an omission.
 *
 * `activeIndex < 0` means focus is not on any of the dialog's focusables — it
 * escaped, or the surface itself holds it — and Tab pulls it back to the end the
 * user was heading for.
 *
 * @param count       how many focusables the dialog holds
 * @param activeIndex index of the focused one, or -1
 * @param shiftKey    whether this is a backwards Tab
 */
export function wrapFocusIndex(
  count: number,
  activeIndex: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return null;
  if (activeIndex < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey) return activeIndex === 0 ? count - 1 : null;
  return activeIndex === count - 1 ? 0 : null;
}

/**
 * Which focusable opens the dialog, given the list and how many of its leading
 * entries belong to the header.
 *
 * The close button is FIRST in the DOM (it is in the header) and is the worst
 * possible landing place: a dialog that opens with focus on its own dismiss
 * control reads as already half-cancelled, and Enter closes it. So the header's
 * controls are skipped in favour of the first control in the body or the footer,
 * and only fall back to being the answer when the dialog has nothing else.
 *
 * Returns -1 when there is nothing to focus at all; the caller then focuses the
 * surface, so focus is inside the dialog either way.
 */
export function initialFocusIndex(count: number, headerCount: number): number {
  if (count <= 0) return -1;
  return headerCount < count ? headerCount : 0;
}

/**
 * What counts as a separate overlay LAYER.
 *
 * `.modal-backdrop` leads because it is the one thing every overlay in this app
 * actually has: `CommandPalette` carries no `role` at all, so a role-only
 * selector (the shape `App.tsx`'s pane-collapse hotkey uses) does not see it.
 * The roles and `aria-modal` follow for surfaces that do not wear the class —
 * `OverviewModal` and `HelpOverlay` build their own scrim.
 */
export const DIALOG_LAYER_SELECTOR = [
  ".modal-backdrop",
  ".overview-modal",
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
].join(",");

/**
 * Whether THIS dialog's trap should act on a Tab press.
 *
 * A dialog's trap is a document listener, so every mounted dialog sees every
 * Tab, and the pull-focus-back-in case (`activeIndex === -1`) makes an
 * unguarded trap take Tab from whatever is genuinely on top. The real sequence:
 * open the create-agent dialog, press Cmd-K, and the palette mounts as a
 * SIBLING — not inert, because the background sweep ran at mount and the palette
 * did not exist yet. Without this rule the create-agent dialog's trap pulls
 * focus into a surface hidden behind the palette's scrim, and the next keystroke
 * lands in a field nobody can see.
 *
 * So a dialog claims Tab only when it holds focus, or when it is the ONLY layer
 * on screen. Both other cases hand Tab back to the browser rather than to a
 * different guess: this shell can say which Tabs are not its business, and it
 * cannot say which are somebody else's.
 *
 * @param focusInThisDialog  focus is inside this dialog's own surface
 * @param focusInAnotherLayer focus is inside some other overlay
 * @param anotherLayerOpen   some other overlay is mounted, wherever focus is
 */
export function claimsTab(
  focusInThisDialog: boolean,
  focusInAnotherLayer: boolean,
  anotherLayerOpen: boolean,
): boolean {
  if (focusInThisDialog) return true;
  return !focusInAnotherLayer && !anotherLayerOpen;
}
