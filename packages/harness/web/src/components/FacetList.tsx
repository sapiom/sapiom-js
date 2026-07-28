import type { JSX } from "react";

import { Pill } from "./Pill";

export interface FacetOption {
  /** The value this row selects. */
  value: string;
  label: string;
  count: number;
}

/**
 * One single-select filter axis: a quiet title, an "everything" row carrying the
 * total, then the values themselves with their counts.
 *
 * Deliberately generic — it knows nothing about templates. It takes options and
 * reports a selection, which is why the template browser can hand it two
 * different axes and why a later surface can reuse it without inheriting the
 * catalog's vocabulary.
 *
 * Radio semantics, not a listbox or a row of buttons: exactly one value is in
 * force at a time (including "all"), which is what `role="radiogroup"` plus
 * `aria-checked` states to a screen reader. Buttons alone would announce five
 * pressable things with no indication that picking one releases the others.
 *
 * Renders nothing below two options. An axis whose every template shares one
 * value discriminates nothing, and an empty one — which is what an unreachable
 * catalog produces — would otherwise draw a title over a single "All (0)" row.
 */
export function FacetList({
  title,
  allLabel,
  allCount,
  options,
  value,
  onSelect,
  testIdPrefix,
}: {
  title: string;
  /** Label for the no-filter row, e.g. "All templates". */
  allLabel: string;
  allCount: number;
  options: FacetOption[];
  /** The selected value, or null for "everything". */
  value: string | null;
  onSelect: (value: string | null) => void;
  testIdPrefix: string;
}): JSX.Element | null {
  if (options.length < 2) return null;

  const rows: Array<FacetOption & { testId: string; selects: string | null }> = [
    { value: "", label: allLabel, count: allCount, testId: `${testIdPrefix}-all`, selects: null },
    ...options.map((option) => ({
      ...option,
      testId: `${testIdPrefix}-${option.value}`,
      selects: option.value,
    })),
  ];

  return (
    <div className="facet">
      <span className="facet-title">{title}</span>
      {/* The rows get their own box so the axis can lie on its side: beside the
          results it is a column, above them (narrow shell) a scroll strip. */}
      <div className="facet-rows" role="radiogroup" aria-label={title}>
        {rows.map((row) => {
          const active = value === row.selects;
          return (
            <button
              key={row.testId}
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? "facet-row is-active" : "facet-row"}
              data-testid={row.testId}
              onClick={() => onSelect(row.selects)}
            >
              <span className="facet-row-label">{row.label}</span>
              <Pill variant="count">{row.count}</Pill>
            </button>
          );
        })}
      </div>
    </div>
  );
}
