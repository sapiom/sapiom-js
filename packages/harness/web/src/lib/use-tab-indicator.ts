import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefCallback } from "react";

/**
 * The moving pill behind a tab row.
 *
 * A tab row that signals its selection by turning a background on under one
 * tab and off under another reads as a blink: two tabs change at once and
 * nothing connects them, so the eye has to re-find the selection after every
 * toggle instead of following it. One pill that travels says the same thing
 * as a continuous movement, and movement is the one channel that survives
 * not being looked at directly.
 *
 * Measured rather than declared, because a tab's width is its label's and only
 * the browser knows that. The row is observed too, so the pill keeps its place
 * when the pane is resized or a label is hidden at a narrow width — a stale
 * pill under the wrong tab is worse than none.
 *
 * The active tab is found by aria-selected, which a tablist has to set anyway:
 * nothing to remember to pass, and nothing to keep in sync with the styling.
 */
export function useTabIndicator(activeKey: string): {
  trackRef: RefCallback<HTMLElement>;
  style: CSSProperties;
} {
  const nodeRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);

  const measure = useCallback(() => {
    const track = nodeRef.current;
    if (!track) return;
    const active = track.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) {
      setBox(null);
      return;
    }
    const t = track.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    setBox({ x: a.left - t.left + track.scrollLeft, w: a.width });
  }, []);

  const observerRef = useRef<ResizeObserver | null>(null);
  const trackRef = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      observerRef.current?.disconnect();
      nodeRef.current = node;
      if (!node) return;
      measure();
      if (typeof ResizeObserver === "undefined") return;
      observerRef.current = new ResizeObserver(measure);
      observerRef.current.observe(node);
    },
    [measure],
  );

  useLayoutEffect(() => {
    measure();
  }, [activeKey, measure]);

  useLayoutEffect(() => () => observerRef.current?.disconnect(), []);

  return {
    trackRef,
    style: box
      ? { transform: `translateX(${box.x}px)`, width: `${box.w}px`, opacity: 1 }
      : // No measurement yet: stay invisible rather than slide in from zero.
        { opacity: 0 },
  };
}
