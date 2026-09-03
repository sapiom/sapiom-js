/**
 * Version-history logic, kept out of the components so it is unit-testable in
 * the Node runner (the web tier tests `lib/`; components are covered by the
 * Playwright e2e tier).
 *
 * Shared by the Versions tab and the picker beside the agent name, so the two
 * surfaces cannot disagree about which version is newest or what to call it.
 */
import type { AgentVersionView } from "@shared/types";

/**
 * `latest` is attached to every newest ready build and is COMPUTED, not stored
 * — Core refuses to store it (a DB CHECK). So it is never a real label: it
 * cannot be moved, and counting it would make "labelled" mean "newest".
 */
export const COMPUTED_LABEL = "latest";

/** The labels a human actually set on this version. */
export function realLabels(v: AgentVersionView): string[] {
  return v.tags.filter((t) => t !== COMPUTED_LABEL);
}

/** First 7 characters — enough to identify, short enough to align. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** What to call a version in one word: its first real label, else the sha. */
export function versionLabel(v: AgentVersionView): string {
  return realLabels(v)[0] ?? shortSha(v.sha);
}

/**
 * The newest READY build.
 *
 * Activating it means "follow latest again", which is why it drives whether the
 * confirm appears: going forward to the newest build is a return to normal;
 * pinning backwards stops later deploys going live.
 *
 * A build that is still building or has failed is not a candidate — offering it
 * as "latest" would point the agent at something that cannot run.
 */
export function newestReadySha(
  versions: readonly AgentVersionView[],
): string | null {
  const ready = versions
    .filter((v) => v.buildStatus === "ready")
    .sort((a, b) => whenMs(b) - whenMs(a));
  return ready[0]?.sha ?? null;
}

/** Deploy time when known, else the commit time. */
function whenMs(v: AgentVersionView): number {
  const ms = Date.parse(v.deployedAt ?? v.committedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Coarse relative age. Coarse on purpose: the exact instant is in the `title`,
 * and a row that re-renders every second draws the eye for no reason.
 *
 * `now` is injectable so this is testable without freezing the clock.
 */
export function whenLabel(v: AgentVersionView, now: number = Date.now()): string {
  const ms = Date.parse(v.deployedAt ?? v.committedAt);
  if (Number.isNaN(ms)) return "—";
  const mins = Math.round((now - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Whether activating `sha` needs a confirm.
 *
 * The single place this decision lives, so the tab and the picker guard
 * identically — two copies of "is this the newest one?" would drift.
 */
export function needsPinConfirm(
  versions: readonly AgentVersionView[],
  sha: string,
): boolean {
  return sha !== newestReadySha(versions);
}

/**
 * What to say about the working copy, in one short phrase.
 *
 * Three genuinely different states, and the wording matters because two of them
 * are easy to conflate:
 *
 * - `deployed as X` — the local bytes hash to a deployed archive version. A
 *   fact, not an inference: packing is reproducible and the digest is the
 *   version's identity.
 * - `not deployed` — the local bytes match no archive version. That includes a
 *   perfectly clean checkout of a GIT-built version, whose sha is a commit and
 *   can never equal a content digest. So this says "not deployed", NOT "you
 *   have unsaved changes" — claiming the latter would be wrong half the time.
 * - `null` — nothing to pack (no `index.ts`, or no directory given). Say
 *   nothing rather than guess.
 */
export function localStateLabel(
  local: { digest: string; matchesSha: string | null } | null,
  versions: readonly AgentVersionView[],
): string | null {
  if (!local) return null;
  if (local.matchesSha) {
    const match = versions.find((v) => v.sha === local.matchesSha);
    return match ? versionLabel(match) : shortSha(local.matchesSha);
  }
  // Nothing comparable: every version came from git, so a content digest could
  // not have matched whatever the working copy contains. Saying "not deployed"
  // here would be a false accusation against a pristine checkout — stay quiet
  // instead. (A 64-hex sha is a sha256 digest; a 40-hex one is a git commit.)
  if (!versions.some((v) => isContentDigest(v.sha))) return null;
  return "not deployed";
}

/** A sha256 digest, as opposed to a 40-hex git commit sha. */
export function isContentDigest(sha: string): boolean {
  return /^[0-9a-f]{64}$/i.test(sha);
}
