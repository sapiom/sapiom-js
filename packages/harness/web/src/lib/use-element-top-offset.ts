import { useLayoutEffect, useState } from "react";

/**
 * Tracks `target`'s top offset and height relative to `container`, so a
 * floating element (the workflow action strip) can stay pinned to a row that
 * lives in a scrollable, reorderable list elsewhere in the tree. Recomputes
 * on scroll (the row's own scroll container, if any), window resize, and any
 * size change to either element — not just on `target`/`container` identity
 * changes, since the row can move without unmounting (e.g. groups above it
 * growing or shrinking).
 */
export function useElementTopOffset(
  target: HTMLElement | null,
  container: HTMLElement | null,
): { top: number; height: number } | null {
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (!target || !container) {
      setRect(null);
      return;
    }

    const measure = (): void => {
      const targetRect = target.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setRect({ top: targetRect.top - containerRect.top, height: targetRect.height });
    };
    measure();

    const scrollParent = target.closest(".rail-list");
    scrollParent?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);

    const observer = new ResizeObserver(measure);
    observer.observe(target);
    observer.observe(container);

    return () => {
      scrollParent?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [target, container]);

  return rect;
}
