/**
 * Does this project's frozen copy of the platform rules still match what the
 * server serves? (SAP-3181, the `check` half of SAP-2908 §3(d).)
 *
 * A scaffolded project carries two npm-shipped files that summarize and point
 * at the served platform rules — `AGENTS.md` and the `sapiom-agent-authoring`
 * skill — each stamped with the content release and body digest it was written
 * against. Neither file can update itself: they are the user's, written once at
 * scaffold time. What `check` can do is read the stamps, ask the server which
 * release it serves (the `X-Sapiom-Content-*` headers of
 * `GET /v1/agents/authoring-rules`, SAP-3190), and warn when they differ, so a
 * stale copy is at least visible rather than silently authoritative.
 *
 * Wording is "differs from the served copy", never "older than": digests do not
 * order, and release ids have collided. Best-effort by construction: no stamp
 * in the project means no request at all, and a non-200, missing header,
 * network error or 5 s timeout means no warning — `check` is a local pre-flight
 * and must not fail, slow down materially, or nag because the network did.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AUTHORING_RULES_PATH,
  authoringRulesDriftWarning,
  parseAuthoringRulesStamp,
  type AuthoringRulesStamp,
} from "@sapiom/agent-core";

import type { ResolvedEnvironment } from "./credentials.js";

/** The project files that carry a stamp, relative to the project directory. */
export const STAMPED_PROJECT_FILES = [
  "AGENTS.md",
  path.join(".claude", "skills", "sapiom-agent-authoring", "SKILL.md"),
] as const;

/** How long to wait for the rules endpoint before giving up on the comparison. */
const FETCH_TIMEOUT_MS = 5000;

/**
 * Read the served release and digest from the endpoint's stamp headers. `null`
 * on any failure — the comparison is then skipped, never reported. Only the
 * headers are read; the body is discarded without buffering.
 */
export async function fetchServedAuthoringRulesStamp(
  env: Pick<ResolvedEnvironment, "apiURL">,
): Promise<AuthoringRulesStamp | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.apiURL}${AUTHORING_RULES_PATH}`, {
      headers: { Accept: "text/markdown, text/plain" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const release = response.headers.get("x-sapiom-content-release");
    const digest = response.headers.get("x-sapiom-content-digest");
    // The body is not needed; release the connection without reading it.
    await response.body?.cancel().catch(() => undefined);
    return release && digest ? { release, digest } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read every stamped file in the project. A file that is absent or unstamped
 * (a project scaffolded before stamps, or a hand-written AGENTS.md) is simply
 * not in the result.
 */
export async function readProjectAuthoringRulesStamps(
  sourceDir: string,
): Promise<Array<{ file: string; stamp: AuthoringRulesStamp }>> {
  const found: Array<{ file: string; stamp: AuthoringRulesStamp }> = [];
  for (const file of STAMPED_PROJECT_FILES) {
    let markdown: string;
    try {
      markdown = await readFile(path.join(sourceDir, file), "utf8");
    } catch {
      continue;
    }
    const stamp = parseAuthoringRulesStamp(markdown);
    if (stamp) found.push({ file, stamp });
  }
  return found;
}

/**
 * The warnings `sapiom_dev_agents_check` appends: one per stamped file whose
 * digest differs from the served copy's. Empty when nothing is stamped, when the
 * server cannot be reached, or when every stamp matches.
 */
export async function authoringRulesDriftWarnings(
  sourceDir: string,
  env: Pick<ResolvedEnvironment, "apiURL">,
): Promise<string[]> {
  const stamped = await readProjectAuthoringRulesStamps(sourceDir);
  if (stamped.length === 0) return [];
  const served = await fetchServedAuthoringRulesStamp(env);
  if (!served) return [];
  const url = `${env.apiURL}${AUTHORING_RULES_PATH}`;
  return stamped.flatMap(({ file, stamp }) => {
    const warning = authoringRulesDriftWarning(file, stamp, served, url);
    return warning ? [warning] : [];
  });
}
