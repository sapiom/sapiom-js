import type { AuthUser } from './types.js';

/**
 * Browser-safe JWT decode (no verification, no crypto).
 * Only use for displaying user info — NOT for authorization.
 */
export function decodeJwt(token: string): AuthUser {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const payload = parts[1];
  const json = decodeBase64Url(payload);

  try {
    return JSON.parse(json) as AuthUser;
  } catch {
    throw new Error('Invalid JWT payload');
  }
}

/**
 * Decode a base64url-encoded string to UTF-8.
 */
function decodeBase64Url(str: string): string {
  // Replace base64url chars with standard base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';

  // Use Buffer in Node.js, atob in browser
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(base64, 'base64').toString('utf8');
  }

  // Browser path
  return decodeURIComponent(
    atob(base64)
      .split('')
      .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join(''),
  );
}
