import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface PaneWidths {
  rail: number;
  canvas: number;
}

const STORAGE_KEY = "sapiom-harness-pane-widths";

export const RAIL_MIN = 180;
export const RAIL_MAX = 480;
export const RAIL_DEFAULT = 220;
export const CANVAS_MIN = 280;
export const CANVAS_MAX = 720;
export const CANVAS_DEFAULT = 420;

// The persistent workflow actions panel — a fixed (non-draggable) grid
// track right next to the rail, same role the icon-only strip's 32px track
// used to play, just wide enough for icon + label side by side.
export const ACTION_PANEL_WIDTH = 168;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadStoredWidths(): PaneWidths {
  const fallback: PaneWidths = { rail: RAIL_DEFAULT, canvas: CANVAS_DEFAULT };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    return {
      rail: clamp(typeof parsed.rail === "number" ? parsed.rail : RAIL_DEFAULT, RAIL_MIN, RAIL_MAX),
      canvas: clamp(typeof parsed.canvas === "number" ? parsed.canvas : CANVAS_DEFAULT, CANVAS_MIN, CANVAS_MAX),
    };
  } catch {
    return fallback;
  }
}

function persist(widths: PaneWidths): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
}

/**
 * Drives the two resize handles between the app's main columns (rail |
 * action panel | terminal | canvas — the action panel rides along at a
 * fixed width right next to the rail, so only rail and canvas are
 * independently draggable). Uses pointer capture on the handle itself
 * rather than window-level listeners, so the drag keeps tracking even if
 * the cursor leaves the thin handle mid-move. Widths persist to
 * localStorage on release; a double-click resets a handle to its default.
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
    (key: keyof PaneWidths, sign: 1 | -1, min: number, max: number) =>
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startValue = widths[key];

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

  const reset = (key: keyof PaneWidths, value: number): void => {
    setWidths((prev) => {
      const next = { ...prev, [key]: value };
      persist(next);
      return next;
    });
  };

  return {
    widths,
    startRailDrag: startDrag("rail", 1, RAIL_MIN, RAIL_MAX),
    startCanvasDrag: startDrag("canvas", -1, CANVAS_MIN, CANVAS_MAX),
    resetRail: () => reset("rail", RAIL_DEFAULT),
    resetCanvas: () => reset("canvas", CANVAS_DEFAULT),
  };
}
