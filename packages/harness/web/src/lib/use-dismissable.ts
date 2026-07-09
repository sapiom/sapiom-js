import { useEffect } from "react";
import type { RefObject } from "react";

interface DismissableOptions {
  onDismiss: () => void;
  /** Wraps the trigger and the panel — a mousedown anywhere outside it dismisses. */
  containerRef: RefObject<HTMLElement | null>;
  /** Focus returns here on Escape, so keyboard users aren't dropped on <body>. */
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
      if (container && event.target instanceof Node && !container.contains(event.target)) {
        onDismiss();
      }
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
