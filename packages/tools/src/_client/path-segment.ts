/**
 * Caller-supplied ids placed in a URL path. `fetch` resolves `.` and `..` segments
 * and an empty segment collapses the route, so any of them would send the request
 * (and its credential) to a different endpoint than the one named.
 */

/** True for a segment value that would not stay a single path segment. */
export function isUnsafeSegment(value: string): boolean {
  return value === "" || value === "." || value === "..";
}

/**
 * Percent-encode `value` as one path segment, after refusing an empty string,
 * `.` or `..`. `name` labels the parameter in the error.
 */
export function encodeSegment(value: string, name: string): string {
  if (isUnsafeSegment(value)) {
    throw new TypeError(
      `@sapiom/tools: ${name} must be a non-empty path segment other than . or ..`,
    );
  }
  return encodeURIComponent(value);
}
