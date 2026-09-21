/**
 * The served platform rules, and the stamp an npm-shipped copy carries to say
 * which release of them it was written against (SAP-3181, SAP-2908 §3(d)).
 *
 * The rules that are true of Sapiom regardless of the installed `@sapiom/agent`
 * — one-off call vs agent, the capability catalog, database lifetime, trigger
 * kinds, App Links, which capability calls an LLM, composing deployed agents,
 * platform vocabulary — are served by the backend at
 * `GET /v1/agents/authoring-rules` (SAP-3223) and stamped with a content
 * release id and a 12-hex sha-256 digest of the body (SAP-3190). Everything
 * this package ships that used to restate one of those rules — the
 * `sapiom-agent-authoring` skill's platform chapters, every scaffolded
 * `AGENTS.md`, `examples/AUTHORING.md` — now carries a short summary, a pointer
 * to the served section, and this stamp. A copy inside a scaffolded project is
 * frozen at scaffold time and can never be corrected; the stamp is what lets
 * `sapiom_dev_agents_check` say "this differs from the served copy" instead of
 * teaching a stale rule silently.
 *
 * The comparison is always "differs from", never "older than": digests do not
 * order, and content-release ids have collided (three PRs once claimed the same
 * id with three bodies), so neither can be ranked. `AUTHORING_RULES_DIGEST` is
 * the first 12 hex of the same sha-256 the backend pins for its bundled-fallback
 * check, so the two repos agree on one token.
 *
 * Bumping: when the backend cuts a new release, run
 * `node scripts/authoring-rules-stamp.mjs --from-served` at the repo root. It
 * rewrites these two constants and every stamped file together;
 * `__tests__/authoring-rules-stamp.test.ts` fails if any of them disagree.
 */

/** Public URL of the served rules (production). */
export const AUTHORING_RULES_URL =
  "https://api.sapiom.ai/v1/agents/authoring-rules";

/** Path of the served rules on any Sapiom API host, for non-production environments. */
export const AUTHORING_RULES_PATH = "/v1/agents/authoring-rules";

/** The content release the shipped summaries and pointers were written against. */
export const AUTHORING_RULES_RELEASE = "1.0";

/** First 12 hex of sha-256 over that release's body — what the server reports in `X-Sapiom-Content-Digest`. */
export const AUTHORING_RULES_DIGEST = "1f3e5cd9648f";

/**
 * The section anchors the served body carries (`<!-- section: NAME -->`), in
 * document order. A pointer names one of these as a URL fragment; the backend
 * treats the set as a contract, so a rename there is a break here.
 */
export const AUTHORING_RULES_SECTIONS = [
  "one-off-vs-agent",
  "capability-catalog",
  "database-lifecycle",
  "trigger-kinds",
  "app-links",
  "llm-call-surface",
  "agent-composition",
  "platform-vocabulary",
] as const;

export type AuthoringRulesSection = (typeof AUTHORING_RULES_SECTIONS)[number];

/** What a stamp records: the release id and the body digest it was written against. */
export interface AuthoringRulesStamp {
  release: string;
  digest: string;
}

/** The stamp the shipped files carry right now. */
export const AUTHORING_RULES_STAMP: AuthoringRulesStamp = {
  release: AUTHORING_RULES_RELEASE,
  digest: AUTHORING_RULES_DIGEST,
};

/**
 * The stamp as it appears in a Markdown file — an HTML comment, so it renders
 * to nothing and survives a reader's edits around it.
 */
export function renderAuthoringRulesStamp(
  stamp: AuthoringRulesStamp = AUTHORING_RULES_STAMP,
): string {
  return `<!-- sapiom-authoring-rules release=${stamp.release} digest=${stamp.digest} -->`;
}

const STAMP_PATTERN =
  /<!--\s*sapiom-authoring-rules\s+release=(\S+)\s+digest=([0-9a-f]{12})\s*-->/;

/**
 * Read the stamp out of a Markdown file's contents. `null` when the file carries
 * none — a project scaffolded before stamps existed, or a hand-written file — in
 * which case there is nothing to compare and `check` stays silent.
 */
export function parseAuthoringRulesStamp(
  markdown: string,
): AuthoringRulesStamp | null {
  const match = STAMP_PATTERN.exec(markdown);
  return match ? { release: match[1], digest: match[2] } : null;
}

/**
 * The warning `check` attaches when a stamped file was written against a
 * different body than the server currently serves. Worded as "differs", never
 * "older" (see the module comment), and it names the file, both stamps and the
 * URL so the reader can go straight to the current text. `null` when the two
 * agree.
 */
export function authoringRulesDriftWarning(
  file: string,
  local: AuthoringRulesStamp,
  served: AuthoringRulesStamp,
  url: string = AUTHORING_RULES_URL,
): string | null {
  if (local.digest === served.digest) return null;
  return (
    `${file} was written against Sapiom platform rules release ${local.release} ` +
    `(digest ${local.digest}); the served copy differs (release ${served.release}, ` +
    `digest ${served.digest}). Its summaries and pointers may no longer match — ` +
    `read the current rules at ${url}.`
  );
}
