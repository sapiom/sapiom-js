/**
 * format-payload — turn a captured per-step payload (`StepView.input` /
 * `.output`) into inspectable text for the run inspector's "Last run" section.
 *
 * Honesty rule lives at the CALL SITE: the inspector gates each block on
 * `value !== undefined`, so a step that never carried an input/output renders
 * no block at all — nothing is fabricated. This function therefore only ever
 * sees a value the run actually captured, and its job is to render THAT value
 * faithfully:
 *   - a real `null` / `false` / `0` / `""` is a legitimate captured value and
 *     is shown as such (never swallowed),
 *   - a plain string passes through unquoted (already legible — no JSON quotes),
 *   - everything else is pretty-printed JSON,
 *   - a non-serializable value (circular reference, BigInt) falls back to
 *     `String()` rather than throwing, because the inspector must never blank
 *     out — or crash on — a step it genuinely observed.
 *
 * Serves the step's own capability output; no provider/model is surfaced.
 */
export function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    // JSON.stringify returns `undefined` for values with no JSON
    // representation (e.g. a bare `undefined`, a function). Callers gate on
    // `!== undefined`, so this is defensive: fall back to a String() form
    // instead of rendering the literal text "undefined".
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
