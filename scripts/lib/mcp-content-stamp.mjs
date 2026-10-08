/**
 * Stamp rules for the served authoring primer, as used by
 * `scripts/mcp-instructions-snapshot.mjs` (SAP-3190, SAP-3579).
 *
 * The backend stamps `GET /v1/mcp/instructions` with `X-Sapiom-Content-Release`
 * and `X-Sapiom-Content-Digest` headers and appends a one-line footer to the
 * body at serve time. The digest is the first twelve hex characters of sha-256
 * over the body WITHOUT that footer.
 *
 * Deliberately small duplicate of `packages/mcp/src/content-stamp.ts`: the
 * runtime applies the same rules before caching a live body, and this script
 * cannot import compiled TypeScript. Change both together.
 */
import { createHash } from "node:crypto";

export const STAMP_DIGEST_LENGTH = 12;

const STAMP_DIGEST = /^[0-9a-f]{12}$/;

/** `\n\n_Sapiom teaching content · authoring · release 2.14 · 055076ab6773 · served live._` */
const STAMP_FOOTER = /\n\n_Sapiom teaching content · [^\n]*\._\s*$/;

/** The delivered body without its serve-time footer: what the digest covers. */
export function stripStampFooter(delivered) {
  return delivered.trim().replace(STAMP_FOOTER, "");
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Lower-cased header when it is exactly twelve hex characters, else `null`. */
export function normalizeStampDigest(header) {
  if (header === null || header === undefined) return null;
  const digest = header.trim().toLowerCase();
  return STAMP_DIGEST.test(digest) ? digest : null;
}
