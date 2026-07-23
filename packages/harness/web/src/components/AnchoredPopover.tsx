/**
 * AnchoredPopover — the app's ONE floating-panel primitive (menus, dropdown
 * pickers, the composer library). Renders into document.body via a portal at
 * a fixed position computed from the trigger, so no ancestor overflow (rail
 * scrollers, the composer's rounded clip) can ever crop it, and no ancestor
 * transform can re-anchor it.
 *
 * The panel keeps its caller's class (one elevation recipe lives in CSS);
 * this component owns only WHERE it floats. Dismiss contract is the app's
 * standard: outside mousedown or Escape (useDismissable), Escape returning
 * focus to the trigger.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, JSX, ReactNode, RefObject } from "react";

import { useDismissable } from "../lib/use-dismissable";

/** Which trigger edge the panel grows from: down = below, up = above;
 *  start = left edges aligned, end = right edges aligned. */
export type PopoverPlacement = "down-start" | "down-end" | "up-start" | "up-end";

const GAP_PX = 4;
/** Keep the panel off the viewport edge so shadows never clip. */
const VIEWPORT_INSET_PX = 8;

function positionFor(anchor: HTMLElement, placement: PopoverPlacement, matchWidth: boolean): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const style: CSSProperties = {
    position: "fixed",
    top: "auto",
    right: "auto",
    bottom: "auto",
    left: "auto",
    // The viewport-derived maxHeight below is a hard cap; the panel scrolls
    // its own content rather than ever growing past an edge.
    overflowY: "auto",
  };
  // Row-shaped triggers (the rail's profile row) want a panel exactly as
  // wide as themselves — width rides the same measure as position.
  if (matchWidth) style.width = rect.width;
  // A panel can never be wider than the viewport minus both insets; the
  // measured clamp pass below then only ever needs to SHIFT it into view.
  style.maxWidth = window.innerWidth - 2 * VIEWPORT_INSET_PX;
  if (placement.startsWith("down")) {
    style.top = rect.bottom + GAP_PX;
    style.maxHeight = window.innerHeight - rect.bottom - GAP_PX - VIEWPORT_INSET_PX;
  } else {
    style.bottom = window.innerHeight - rect.top + GAP_PX;
    style.maxHeight = rect.top - GAP_PX - VIEWPORT_INSET_PX;
  }
  if (placement.endsWith("start")) {
    style.left = Math.max(VIEWPORT_INSET_PX, rect.left);
  } else {
    style.right = Math.max(VIEWPORT_INSET_PX, window.innerWidth - rect.right);
  }
  return style;
}

export interface AnchoredPopoverProps {
  open: boolean;
  /** The control that opened the panel — anchors position, takes focus back
   *  on Escape, and its own clicks never count as outside-dismiss. */
  anchorRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  placement: PopoverPlacement;
  /** Size the panel to the anchor's own width (row-shaped triggers). */
  matchWidth?: boolean;
  /** The panel's existing recipe class (e.g. "session-menu") — elevation,
   *  padding, and width stay in CSS. */
  className: string;
  role?: string;
  testid?: string;
  children: ReactNode;
}

export function AnchoredPopover({
  open,
  anchorRef,
  onDismiss,
  placement,
  matchWidth = false,
  className,
  role,
  testid,
  children,
}: AnchoredPopoverProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  // The portal moves the panel OUT of the trigger's subtree, so the dismiss
  // container is the panel itself; the anchor stays excluded via triggerRef.
  useDismissable(open, { onDismiss, containerRef: panelRef, triggerRef: anchorRef });

  const reposition = useCallback((): void => {
    const anchor = anchorRef.current;
    if (anchor) setStyle(positionFor(anchor, placement, matchWidth));
  }, [anchorRef, placement, matchWidth]);

  // Position before paint on open (no one-frame jump), then follow window
  // resizes and any ancestor scroll (capture) while open.
  useLayoutEffect(() => {
    if (open) reposition();
    else setStyle(null);
  }, [open, reposition]);

  // Measured clamp pass, still before paint: positionFor aligns one edge to
  // the trigger without knowing the panel's width, so a wide panel near the
  // opposite viewport edge could overhang it. Measure the rendered panel and
  // shift it back inside the inset; the corrected style re-measures to a
  // zero delta, so this settles in one extra pass.
  useLayoutEffect(() => {
    if (!open || style == null) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    let dx = 0;
    if (rect.left < VIEWPORT_INSET_PX) dx = VIEWPORT_INSET_PX - rect.left;
    else if (rect.right > window.innerWidth - VIEWPORT_INSET_PX) {
      dx = window.innerWidth - VIEWPORT_INSET_PX - rect.right;
    }
    if (Math.abs(dx) < 0.5) return;
    setStyle((prev) =>
      prev == null
        ? prev
        : {
            ...prev,
            left: typeof prev.left === "number" ? prev.left + dx : prev.left,
            right: typeof prev.right === "number" ? prev.right - dx : prev.right,
          },
    );
  }, [open, style]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  if (!open || style == null) return null;
  return createPortal(
    <div ref={panelRef} className={className} role={role} data-testid={testid} style={style}>
      {children}
    </div>,
    document.body,
  );
}
