/**
 * Utility functions for the Sapiom SDK
 */

/**
 * Gets a header value from a headers object (case-insensitive)
 * HTTP headers are case-insensitive per RFC 7230, but JavaScript objects are case-sensitive
 *
 * @param headers Headers object
 * @param headerName Header name to find (case-insensitive)
 * @returns Header value or undefined
 */
export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): string | undefined {
  const lowerHeaderName = headerName.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerHeaderName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

/**
 * Checks if a header exists in a headers object (case-insensitive)
 *
 * @param headers Headers object
 * @param headerName Header name to check (case-insensitive)
 * @returns true if header exists
 */
export function hasHeader(headers: Record<string, string | string[] | undefined>, headerName: string): boolean {
  return getHeader(headers, headerName) !== undefined;
}

/**
 * Sets a header in a headers object, removing any existing case variants
 *
 * @param headers Headers object
 * @param headerName Header name to set
 * @param value Header value
 * @returns New headers object with header set
 */
export function setHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
  value: string,
): Record<string, string> {
  const lowerHeaderName = headerName.toLowerCase();
  const newHeaders: Record<string, string> = {};

  // Copy all headers except case variants of the one we're setting
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerHeaderName) {
      newHeaders[key] = Array.isArray(val) ? val[0] || '' : val || '';
    }
  }

  // Set the new header value
  newHeaders[headerName] = value;

  return newHeaders;
}

/**
 * Removes a header from a headers object (case-insensitive)
 *
 * @param headers Headers object
 * @param headerName Header name to remove (case-insensitive)
 * @returns New headers object without the header
 */
export function removeHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): Record<string, string> {
  const lowerHeaderName = headerName.toLowerCase();
  const newHeaders: Record<string, string> = {};

  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerHeaderName) {
      newHeaders[key] = Array.isArray(val) ? val[0] || '' : val || '';
    }
  }

  return newHeaders;
}
