/** `fetch` resolves dot segments and an empty id collapses the route, so either would
 * send the credential to an endpoint other than the one named. */

export function isUnsafeSegment(value: string): boolean {
  return value === "" || value === "." || value === "..";
}

export function encodeSegment(value: string, name: string): string {
  if (isUnsafeSegment(value)) {
    throw new TypeError(
      `@sapiom/tools: ${name} must be a non-empty path segment other than . or ..`,
    );
  }
  return encodeURIComponent(value);
}
