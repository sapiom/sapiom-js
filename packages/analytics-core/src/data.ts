/**
 * Event `data` sanitation: guarantee the payload is a JSON-serializable
 * object and cap each top-level field at ~16 KB.
 */

/** Per-field cap (~16 KB), measured on the serialized value. */
export const MAX_FIELD_LENGTH = 16 * 1024;

/**
 * Normalize arbitrary caller input into a safe `data` object.
 *
 * - `null`/`undefined` → `{}`
 * - non-objects (and arrays) → `{ value: <input> }`
 * - oversized fields are truncated and `data._truncated: true` is set
 * - unserializable fields (circular, BigInt, …) are replaced, never thrown on
 */
export function sanitizeData(input: unknown): Record<string, unknown> {
  try {
    if (input === null || input === undefined) return {};
    const source: Record<string, unknown> =
      typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : { value: input };

    const data: Record<string, unknown> = {};
    let truncated = false;
    for (const [key, value] of Object.entries(source)) {
      const capped = capValue(value);
      data[key] = capped.value;
      if (capped.truncated) truncated = true;
    }
    if (truncated) data._truncated = true;
    return data;
  } catch {
    return {};
  }
}

function capValue(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    return value.length > MAX_FIELD_LENGTH
      ? { value: value.slice(0, MAX_FIELD_LENGTH), truncated: true }
      : { value, truncated: false };
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Circular references, BigInt, … — drop the value, keep the event.
    return { value: "[unserializable]", truncated: true };
  }
  // undefined / function / symbol serialize to nothing; JSON will omit them.
  if (serialized === undefined) return { value: undefined, truncated: false };
  if (serialized.length > MAX_FIELD_LENGTH) {
    return { value: serialized.slice(0, MAX_FIELD_LENGTH), truncated: true };
  }
  return { value, truncated: false };
}
