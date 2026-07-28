import type { JSX, ReactNode } from "react";

/**
 * A small inline label.
 *
 * Two jobs, one recipe: a freeform registry `tag` on a template card, and a
 * count beside a facet row. The `count` variant is tabular-numeric so a column
 * of them lines up on the digits rather than drifting with the glyph widths.
 */
export function Pill({
  children,
  variant = "tag",
  title,
}: {
  children: ReactNode;
  variant?: "tag" | "count";
  /** Native tooltip, for a label the card had to truncate. */
  title?: string;
}): JSX.Element {
  return (
    <span className={variant === "count" ? "pill pill--count" : "pill"} title={title}>
      {children}
    </span>
  );
}
