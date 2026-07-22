import { useEffect } from "react";
import type { RefObject } from "react";

interface DismissableOptions {
  onDismiss: () => void;
  /** The panel itself (or a wrapper around trigger + panel): a mousedown
   *  anywhere outside it dismisses. */
  containerRef: RefObject<HTMLElement | null>;
  /** Focus returns here on Escape. Mousedowns inside it are also ignored,
   *  so a panel that floats away from its trigger can still be toggled by
   *  that trigger without dismiss-then-reopen flicker. */
  triggerRef?: RefObject<HTMLElement | null>;
}

/**
 * Standard light-dismiss for popovers/dropdowns/modals: clicking anywhere
 * outside the container or pressing Escape closes them.
 *
 * Outside detection is on mousedown, not click — a click's target is the
 * nearest common ancestor of where the press started and ended, so a drag
 * that starts inside the panel (text selection) and releases outside would
 * otherwise count as an outside click and dismiss mid-gesture.
 */
export function useDismissable(open: boolean, { onDismiss, containerRef, triggerRef }: DismissableOptions): void {
  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent): void => {
      const container = containerRef.current;
      if (!container || !(event.target instanceof Node)) return;
      if (container.contains(event.target)) return;
      // The trigger toggles the panel itself; dismissing here too would close
      // on mousedown only for the click to immediately reopen it.
      if (triggerRef?.current?.contains(event.target)) return;
      onDismiss();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      onDismiss();
      triggerRef?.current?.focus();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onDismiss, containerRef, triggerRef]);
}
