/**
 * Everything a dialog DOES, separated from everything a dialog IS.
 *
 * `components/Dialog.tsx` renders markup and nothing else; this hook owns the
 * four behaviors the design system's `DialogSurface` gets from Radix and that
 * the harness previously had in eleven hand-rolled copies, most of them missing
 * two or three of them:
 *
 *   1. DISMISSAL — Escape and an outside press, via the app-wide
 *      `useDismissable` so a dialog dismisses exactly like every popover.
 *   2. FOCUS CONTAINMENT — Tab cycles inside the dialog instead of walking the
 *      rail behind it. Only `RunSheet` had this; the create/add/remove family
 *      let Tab wander straight out of the modal into the page underneath.
 *   3. INITIAL AND RESTORED FOCUS — one control receives focus on open, and the
 *      control that opened the dialog gets it back on close, whether the close
 *      came from Escape, the × , the backdrop, or Cancel. Before this, focus
 *      returned only on Escape, and only when a `triggerRef` had been passed.
 *   4. AN INERT BACKGROUND — the page behind the scrim stops taking pointer and
 *      assistive-tech attention while a modal is up. `aria-modal` alone does not
 *      do this: it is a hint to screen readers and nothing else.
 *
 * It is a hook rather than markup because none of it is presentation, and
 * because the pieces that ARE pure decisions (which index Tab lands on, which
 * control opens focused) live in `dialog-focus.ts` where the Node test runner
 * can reach them without a DOM.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import {
  claimsTab,
  DIALOG_FOCUSABLE_SELECTOR,
  DIALOG_LAYER_SELECTOR,
  initialFocusIndex,
  wrapFocusIndex,
} from "./dialog-focus";
import { useDismissable } from "./use-dismissable";

export interface DialogBehaviorOptions {
  /** The dialog surface itself — the panel, never the scrim. */
  containerRef: RefObject<HTMLElement | null>;
  /** The dialog's header, so its close button can be skipped when choosing
   *  where focus opens. */
  headerRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  /**
   * Whether Escape and an outside press dismiss.
   *
   * `false` while a submit is in flight: the agent is being written to disk and
   * pulling the dialog would leave the user with no report of how it went. Focus
   * stays contained either way — a dialog you cannot dismiss is still a dialog
   * you cannot Tab out of.
   */
  dismissable?: boolean;
  /** The control that opened the dialog. Focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** The control that should open focused. Defaults to the first control
   *  outside the header — see `initialFocusIndex`. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/** The dialog's focusables, in tab order, as the browser would visit them. */
function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
  ).filter(
    // `offsetParent` is null for anything `display: none` (and for a
    // `position: fixed` element, which a dialog's own children never are).
    // A trap that counted hidden controls would park focus on nothing, and the
    // browser would disagree with it about where Tab goes next.
    (element) => element.offsetParent !== null,
  );
}

/**
 * Take the rest of the page out of the tab order and out of the accessibility
 * tree for as long as the dialog is up.
 *
 * Walks the dialog's ancestor chain to `<body>` marking every SIBLING inert, so
 * the background goes inert without the dialog having to be portalled to the
 * body first. An element another layer already marked is skipped and therefore
 * not un-marked on the way out: each layer restores exactly what it set, which
 * is what makes a dialog opened over a dialog restore correctly.
 */
function inertBackground(container: HTMLElement): () => void {
  const marked: HTMLElement[] = [];
  let node: HTMLElement | null = container;
  while (node?.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
    if (parent === document.body) break;
    node = parent;
  }
  return () => {
    for (const element of marked) element.removeAttribute("inert");
  };
}

export function useDialogBehavior({
  containerRef,
  headerRef,
  onDismiss,
  dismissable = true,
  triggerRef,
  initialFocusRef,
}: DialogBehaviorOptions): void {
  // The control that had focus when this dialog opened, captured in the inert
  // sweep below — see why there rather than here.
  const openedFromRef = useRef<HTMLElement | null>(null);

  useDismissable(dismissable, { onDismiss, containerRef, triggerRef });

  // DECLARED FIRST, AND A LAYOUT EFFECT, both on purpose. React runs effect
  // cleanups in declaration order within a phase and runs every layout cleanup
  // before any passive one, so this ordering is the only thing that makes the
  // focus restore below land: `focus()` on an element that is still inside an
  // inert subtree is silently a no-op, and the trigger is inside one until this
  // cleanup has run.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Read the opener BEFORE the sweep, and only here. Making a subtree inert
    // blurs whatever inside it holds focus, so by the time any later effect
    // looks, `document.activeElement` is already `<body>` and the identity of
    // the control that opened this dialog is gone.
    openedFromRef.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null;
    return inertBackground(container);
  }, [containerRef]);

  // Focus in on open, focus back on close. One layout effect rather than two,
  // because the element to restore to has to be read BEFORE the dialog steals
  // focus and used AFTER it gives it up — that pairing is the whole behavior.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // A consumer's own `autoFocus` (the confirm dialogs' safe action) has
    // already run by now and is the more specific answer — leave it alone.
    if (!container.contains(document.activeElement)) {
      const explicit = initialFocusRef?.current;
      if (explicit) explicit.focus();
      else {
        const focusables = focusablesIn(container);
        const header = headerRef.current;
        const headerCount = header
          ? focusables.filter((element) => header.contains(element)).length
          : 0;
        const index = initialFocusIndex(focusables.length, headerCount);
        // No control at all still puts focus INSIDE the dialog: the surface
        // carries tabIndex={-1} exactly so this case has an answer.
        (focusables[index] ?? container).focus();
      }
    }

    return () => {
      const restoreTo = triggerRef?.current ?? openedFromRef.current;
      if (!restoreTo?.isConnected) return;
      // Don't yank focus from wherever it has legitimately gone: restore only
      // when the closing dialog is what still holds it.
      const active = document.activeElement;
      if (active && active !== document.body && !container.contains(active)) return;
      restoreTo.focus();
    };
  }, [containerRef, headerRef, initialFocusRef, triggerRef]);

  // Containment. Document-level rather than an `onKeyDown` on the surface, so a
  // Tab pressed while focus has somehow escaped still pulls it back in.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const container = containerRef.current;
      if (!container) return;
      const active = document.activeElement;
      const inside = active instanceof Node && container.contains(active);
      // A layer that mounted AFTER this one is not inert — the sweep above ran
      // when it did not exist — so the trap has to decline Tab itself rather
      // than rely on the background being unreachable.
      const ownLayer = container.closest(DIALOG_LAYER_SELECTOR) ?? container;
      const inAnotherLayer =
        !inside &&
        active instanceof Element &&
        active.closest(DIALOG_LAYER_SELECTOR) != null;
      // An ancestor layer is one this dialog opened INSIDE (the overview modal
      // hosts the add-agents dialog); that one is below, not above.
      const anotherLayerOpen = Array.from(
        document.querySelectorAll(DIALOG_LAYER_SELECTOR),
      ).some(
        (layer) =>
          layer !== ownLayer && !layer.contains(ownLayer) && !ownLayer.contains(layer),
      );
      if (!claimsTab(inside, inAnotherLayer, anotherLayerOpen)) return;
      const focusables = focusablesIn(container);
      const activeIndex = focusables.indexOf(active as HTMLElement);
      const next = wrapFocusIndex(focusables.length, activeIndex, event.shiftKey);
      if (next == null) return;
      event.preventDefault();
      focusables[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [containerRef]);

}
