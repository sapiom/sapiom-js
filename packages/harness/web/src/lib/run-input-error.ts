/**
 * Helpers for detecting whether a run failure was caused by a missing required
 * input field. Used to decide whether to open the run-input dialog after a
 * run fires and fails, versus showing the failure inline and leaving the dialog
 * closed.
 *
 * Both local (NDJSON step trace) and prod (thrown ApiError) runs surface the
 * same message shape from the runtime, so one parser handles both:
 *
 *   "Input for step 'research' failed validation: topic: must have required property 'topic'"
 *   "must have required property 'query'"
 *   "failed validation"            ← general validation failure
 */

const REQUIRED_PROPERTY_RE = /required property ['"]?([A-Za-z0-9_]+)['"]?/g;

/**
 * Parse field names from a run failure message that indicates a missing
 * required input.
 *
 * Returns an ordered, deduplicated list of field names when the message
 * describes a missing-input failure. Returns an empty array for any other
 * failure message (network error, step logic error, etc.) so callers can
 * treat a non-empty result as "show the run-input dialog" and an empty result
 * as "let the existing error UI handle it".
 *
 * Detection logic:
 *   - A message that matches `required property '<name>'` → input error; the
 *     field names are extracted from the capture groups.
 *   - A message that contains "failed validation" but has no explicit field
 *     names → input error with an empty field list (the dialog will open with
 *     whatever skeleton it can derive).
 *   - Anything else → not an input error; returns [].
 */
export function parseMissingInputFields(message: string): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];

  let match: RegExpExecArray | null;
  REQUIRED_PROPERTY_RE.lastIndex = 0;
  while ((match = REQUIRED_PROPERTY_RE.exec(message)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      fields.push(name);
    }
  }

  if (fields.length > 0) return fields;

  // "failed validation" with no specific field names: still an input error,
  // but we cannot name the fields — return a sentinel empty array that
  // is still truthy-on-length-check for callers (they should check
  // `isInputError` separately). Use `isInputValidationError` for the gate.
  if (/failed validation/i.test(message)) return [];

  // Not an input-related failure.
  return [];
}

/**
 * Returns true when the message indicates any kind of input validation failure,
 * regardless of whether specific field names could be extracted. Callers that
 * only need to decide "open dialog or not" should use this rather than checking
 * `.length` on `parseMissingInputFields`, because a general "failed validation"
 * message is still an input error even though it yields zero field names.
 */
export function isInputValidationError(message: string): boolean {
  REQUIRED_PROPERTY_RE.lastIndex = 0;
  if (REQUIRED_PROPERTY_RE.test(message)) return true;
  return /failed validation/i.test(message);
}
