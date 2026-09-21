/**
 * Pure rewriting for `scripts/authoring-rules-stamp.mjs`: move every stamp the
 * repo ships to a new release/digest pair (SAP-3181). Kept free of I/O so the
 * regexes can be unit-tested; the CLI wrapper walks the files.
 */

/** `<!-- sapiom-authoring-rules release=X digest=Y -->` in Markdown. */
export const MARKDOWN_STAMP =
  /<!--\s*sapiom-authoring-rules\s+release=\S+\s+digest=[0-9a-f]{12}\s*-->/g;

/**
 * `.../authoring-rules#section (written against release X)` — the JSDoc form,
 * used where a comment cannot hold an HTML comment (`@sapiom/tools`).
 */
export const JSDOC_STAMP =
  /(authoring-rules(?:#[a-z-]+)?\s*(?:\*\s*)?\(written against release )([^)\s]+)(\))/g;

/** `AUTHORING_RULES_RELEASE = "…"` / `AUTHORING_RULES_DIGEST = "…"` in agent-core. */
export const CONSTANT_STAMP =
  /(export const AUTHORING_RULES_(RELEASE|DIGEST) =\s*)"[^"]*"/g;

/** The prose form the skill, AGENTS.md and AUTHORING.md carry: "written against release X". */
export const PROSE_STAMP = /(written against release )\d+\.\d+/g;

export function renderMarkdownStamp({ release, digest }) {
  return `<!-- sapiom-authoring-rules release=${release} digest=${digest} -->`;
}

/**
 * Rewrite one file's contents for the new stamp. Returns the new text, or the
 * input unchanged when the file carries nothing to move.
 */
export function restamp(source, { release, digest }) {
  return source
    .replace(MARKDOWN_STAMP, renderMarkdownStamp({ release, digest }))
    .replace(JSDOC_STAMP, `$1${release}$3`)
    .replace(PROSE_STAMP, `$1${release}`)
    .replace(
      CONSTANT_STAMP,
      (_m, head, which) => `${head}"${which === "RELEASE" ? release : digest}"`,
    );
}

export function isDigest(value) {
  return /^[0-9a-f]{12}$/.test(value);
}
