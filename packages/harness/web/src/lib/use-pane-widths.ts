import { useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** The one breakpoint where the three-pane shell folds into one column —
 *  must match styles.css's "Mobile shell" media block so the JSX mode flip
 *  (drawer/sheet) and the CSS reflow always happen together. */
export const MOBILE_SHELL_QUERY = "(max-width: 768px)";

/** Non-reactive read — for lazy state initializers (first paint must not
 *  flash the desktop shell on a phone before an effect can collapse it). */
export function isMobileShell(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_SHELL_QUERY).matches;
}

function subscribeMobileShell(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_SHELL_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Reactive form of isMobileShell — re-renders when the viewport crosses the
 *  breakpoint (rotation, window resize, devtools device emulation). */
export function useMobileShell(): boolean {
  return useSyncExternalStore(subscribeMobileShell, isMobileShell, () => false);
}

export interface PaneWidths {
  rail: number;
  /** null = the default: terminal and canvas split the main area equally. */
  canvas: number | null;
}

const STORAGE_KEY = "sapiom-harness-pane-widths";

export const RAIL_MIN = 180;
export const RAIL_MAX = 480;
/** 20rem — the workspace rail's default width. */
export const RAIL_DEFAULT = 320;
/** 20rem — the canvas pane can never be squeezed below this. */
export const CANVAS_MIN = 320;
export const CANVAS_MAX = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadStoredWidths(): PaneWidths {
  const fallback: PaneWidths = { rail: RAIL_DEFAULT, canvas: null };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    return {
      rail: clamp(typeof parsed.rail === "number" ? parsed.rail : RAIL_DEFAULT, RAIL_MIN, RAIL_MAX),
      // Absent/null canvas = equal split (the default); a stored number is a
      // deliberate user drag and wins until the next double-click reset.
      canvas: typeof parsed.canvas === "number" ? clamp(parsed.canvas, CANVAS_MIN, CANVAS_MAX) : null,
    };
  } catch {
    return fallback;
  }
}

function persist(widths: PaneWidths): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
}

/**
 * Drives the two resize handles between the app's columns (rail | terminal |
 * canvas). The canvas defaults to an equal split with the terminal (canvas
 * = null → 1fr/1fr grid tracks); dragging pins it to a px width, and a
 * double-click returns it to the equal split. Uses pointer capture on the
 * handle itself rather than window-level listeners, so the drag keeps
 * tracking even if the cursor leaves the thin handle mid-move. Widths
 * persist to localStorage on release.
 */
export function usePaneWidths(): {
  widths: PaneWidths;
  startRailDrag: (e: ReactPointerEvent<HTMLDivElement>) => void;
  startCanvasDrag: (e: ReactPointerEvent<HTMLDivElement>) => void;
  resetRail: () => void;
  resetCanvas: () => void;
} {
  const [widths, setWidths] = useState<PaneWidths>(loadStoredWidths);

  const startDrag =
    (key: keyof PaneWidths, sign: 1 | -1, min: number, max: number, resolveStart: () => number) =>
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startValue = resolveStart();

      const handleMove = (moveEvent: PointerEvent): void => {
        const next = clamp(startValue + (moveEvent.clientX - startX) * sign, min, max);
        setWidths((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
      };
      const handleUp = (): void => {
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", handleUp);
        setWidths((current) => {
          persist(current);
          return current;
        });
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", handleUp);
    };

  const reset = (key: keyof PaneWidths, value: number | null): void => {
    setWidths((prev) => {
      const next = { ...prev, [key]: value };
      persist(next);
      return next;
    });
  };

  return {
    widths,
    startRailDrag: startDrag("rail", 1, RAIL_MIN, RAIL_MAX, () => widths.rail),
    // Dragging away from the equal split needs a concrete starting px —
    // measure the live pane, since "equal" has no stored number.
    startCanvasDrag: startDrag("canvas", -1, CANVAS_MIN, CANVAS_MAX, () => {
      if (widths.canvas != null) return widths.canvas;
      const pane = document.querySelector(".canvas-pane");
      return pane ? pane.getBoundingClientRect().width : CANVAS_MIN;
    }),
    resetRail: () => reset("rail", RAIL_DEFAULT),
    resetCanvas: () => reset("canvas", null),
  };
}
