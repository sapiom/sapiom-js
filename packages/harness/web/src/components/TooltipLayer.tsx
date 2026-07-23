import { useEffect, useRef } from "react";
import type { JSX } from "react";

/**
 * One app-wide tooltip: a single fixed-position layer driven by delegated
 * pointer events, sourcing text from `data-tooltip` or native `title`
 * attributes (titles are stashed on first hover so the browser bubble never
 * doubles it). Fixed positioning means it can never be cropped by a
 * scroller, panel, or overflow clip — and one listener + direct DOM writes
 * keep it out of React's render path entirely.
 */
export function TooltipLayer(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let anchor: Element | null = null;

    const hide = (): void => {
      anchor = null;
      tip.dataset.show = "false";
      // Empty when hidden — stale text must never linger in the DOM.
      tip.textContent = "";
    };

    const show = (target: Element): void => {
      const el = target.closest("[data-tooltip], [title], [data-tip-stash]");
      if (!el || el === anchor) return;
      // Stash the native title so the browser bubble never doubles ours.
      const titled = el as HTMLElement;
      if (titled.title) {
        titled.dataset.tipStash = titled.title;
        titled.removeAttribute("title");
      }
      const text = titled.dataset.tooltip || titled.dataset.tipStash;
      if (!text) return;
      anchor = el;
      tip.textContent = text;
      tip.dataset.show = "true";
      const rect = el.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = tip;
      // Rail rows stack tightly, so an above-placed tip fully covers the very
      // sibling row the user is scanning toward — rail tooltips instead fly
      // out to the RIGHT of the rail edge, vertically centered on the row.
      const rail = el.closest(".rail-workflows");
      if (rail && rail.getBoundingClientRect().right + w + 14 <= window.innerWidth) {
        const x = rail.getBoundingClientRect().right + 8;
        const y = Math.min(Math.max(rect.top + rect.height / 2 - h / 2, 6), window.innerHeight - h - 6);
        tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        return;
      }
      // Everywhere else: above and centered; clamped to the viewport; below
      // when out of room (also the rail's fallback when no room remains right).
      const x = Math.min(Math.max(rect.left + rect.width / 2 - w / 2, 6), window.innerWidth - w - 6);
      const y = rect.top - h - 7 >= 4 ? rect.top - h - 7 : rect.bottom + 7;
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };

    const onOver = (e: Event): void => show(e.target as Element);
    const onOut = (e: Event): void => {
      if (anchor && !anchor.contains((e as PointerEvent).relatedTarget as Node)) hide();
    };
    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  return <div ref={ref} className="app-tooltip" data-show="false" role="tooltip" aria-hidden="true" />;
}
