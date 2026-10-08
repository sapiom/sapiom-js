import { createHash } from "node:crypto";

/**
 * The provenance stamp the backend puts on served teaching content
 * (SAP-3190): `X-Sapiom-Content-Release` / `-Digest` / `-Key` headers, and a
 * one-line footer appended to the body at serve time. The digest is the first
 * twelve hex characters of sha-256 over the body WITHOUT that footer.
 *
 * This is the runtime half of a deliberately small duplicate: the release-time
 * generator, `scripts/lib/mcp-content-stamp.mjs`, applies the same rules to
 * the same endpoint but cannot import compiled TypeScript. Change both
 * together; each file's tests pin the behaviour.
 */

/** How much of a sha-256 the stamp carries. */
export const STAMP_DIGEST_LENGTH = 12;

const STAMP_DIGEST = /^[0-9a-f]{12}$/;

/** `\n\n_Sapiom teaching content · authoring · release 2.14 · 055076ab6773 · served live._` */
const STAMP_FOOTER = /\n\n_Sapiom teaching content · [^\n]*\._\s*$/;

/** The delivered body without its serve-time footer: what the digest covers. */
export function stripStampFooter(delivered: string): string {
  return delivered.trim().replace(STAMP_FOOTER, "");
}

/** Full sha-256 hex of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Lower-cased header value when it is exactly twelve hex characters, else
 * `null`. Exactness matters: a prefix comparison against a one-character
 * header would accept almost anything.
 */
export function normalizeStampDigest(header: string | null): string | null {
  if (header === null) return null;
  const digest = header.trim().toLowerCase();
  return STAMP_DIGEST.test(digest) ? digest : null;
}

export interface ValidatedStamp {
  /** The body as delivered, footer included. */
  delivered: string;
  /** The body the digest describes: delivered minus the footer. */
  canonical: string;
  release: string;
  digest: string;
}

/**
 * Accept a served body only when it carries a complete stamp and hashes to
 * it: both headers present, the digest well-formed, and sha-256 of the
 * footer-stripped body starting with it. `null` otherwise, so a caller never
 * caches or snapshots an unstamped or tampered body.
 */
export function validateStampedBody(
  text: string,
  headers: { release: string | null; digest: string | null },
): ValidatedStamp | null {
  const release = headers.release?.trim() ?? "";
  const digest = normalizeStampDigest(headers.digest);
  if (release.length === 0 || digest === null) return null;
  const delivered = text.trim();
  const canonical = stripStampFooter(delivered);
  if (canonical.length === 0) return null;
  if (sha256Hex(canonical).slice(0, STAMP_DIGEST_LENGTH) !== digest) {
    return null;
  }
  return { delivered, canonical, release, digest };
}
