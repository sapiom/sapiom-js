export const compareCanonicalStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizedLineEndings = (value: string): string =>
  value.replace(/\r\n?/gu, "\n");

/** RFC-8259-shaped canonical JSON with binary key ordering and normalized text. */
export function canonicalJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (entry === undefined)
      throw new TypeError("undefined is not canonical JSON");
    if (typeof entry === "string") return normalizedLineEndings(entry);
    if (typeof entry === "number" && !Number.isFinite(entry))
      throw new TypeError("non-finite number is not canonical JSON");
    if (
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "number"
    )
      return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry === "object") {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("non-plain object is not canonical JSON");
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => compareCanonicalStrings(left, right))
          .map(([key, field]) => [key, visit(field)]),
      );
    }
    throw new TypeError("unsupported canonical JSON value");
  };
  return JSON.stringify(visit(value));
}
