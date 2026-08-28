/**
 * The name to give a server-side agent the deploy route has to create for a
 * project that was never linked (a gallery-template clone).
 *
 * The honest answer is the agent's own `defineAgent({ name })`, which the
 * canvas extraction already surfaces as `graph.manifestName` — and which the
 * registry stores as `definitionSlug` and `sapiom.json` caches as `name`. Read
 * through the fingerprint cache (core/canvas-cache.ts), so this is normally
 * free: the canvas renders on bind, so the extraction is already warm.
 *
 * Never throws and never blocks a deploy: any failure (no `node_modules` yet,
 * a bundle error, the check process timing out) comes back as null and the
 * caller falls back to a weaker name source.
 */
import {
  extractWorkflowGraphCached,
  type CachedExtractionOptions,
} from "./canvas-cache.js";
import { listSourceFiles } from "./canvas-interconnections.js";

export type ManifestNameInspection =
  | { status: "found"; name: string }
  | { status: "absent" }
  /** `retryable`: the same unchanged source could still name this agent. */
  | { status: "failed"; retryable: boolean };

/**
 * Whether a later projection of the SAME unchanged source could still name
 * this agent. Extraction failures are deliberately not cached
 * (core/canvas-cache.ts), so a re-run is free to succeed — and several causes
 * do resolve on their own terms: dependencies get installed, a check process
 * that crashed or timed out under load succeeds on the next attempt. None of
 * those fire the graph watcher, which only reacts to `.ts`/`.tsx` outside
 * ignored directories, so the caller must keep offering a manual retry.
 *
 * `reason` cannot answer this — it is free-form text assembled from an agent's
 * own error message, a stderr tail, or a timeout string — so the only claim
 * made here is the one the filesystem proves outright: a project with no
 * TypeScript in it has no `defineAgent` to find, and no install or re-run
 * will invent one. Adding a source file changes the answer, and adding one is
 * precisely what the watcher does see.
 *
 * Deliberately one-directional. Guessing "settled" wrongly caches a
 * provisional label and removes the retry that would have fixed it; guessing
 * "retryable" wrongly just leaves the project as it behaves today.
 */
async function couldStillBeNamed(projectDir: string): Promise<boolean> {
  try {
    return (await listSourceFiles(projectDir)).length > 0;
  } catch {
    return true;
  }
}

export type ManifestNameInspectionOptions = CachedExtractionOptions;

/**
 * Inspect the declared manifest name while preserving the difference between
 * a valid unnamed agent and an extraction failure. Inventory uses the richer
 * result to avoid warning for the normal unnamed case, and `retryable` to
 * decide whether the failure can still be cleared without a source edit.
 */
export async function inspectManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
  options: ManifestNameInspectionOptions = {},
): Promise<ManifestNameInspection> {
  try {
    const { result } =
      options.authorizeBeforeLaunch || options.beforeLaunchAuthorization
        ? await extract(projectDir, undefined, options)
        : await extract(projectDir);
    if (!result.ok) {
      if (result.code === "NO_DEFINITION") return { status: "absent" };
      return {
        status: "failed",
        retryable: await couldStillBeNamed(projectDir),
      };
    }
    const name = result.graph.manifestName.trim();
    return name === "" ? { status: "absent" } : { status: "found", name };
  } catch {
    // The extractor itself misbehaved; we learned nothing about why. Assume
    // recoverable so the caller keeps its retry affordance.
    return { status: "failed", retryable: true };
  }
}

export async function resolveManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
): Promise<string | null> {
  const inspected = await inspectManifestName(projectDir, extract);
  return inspected.status === "found" ? inspected.name : null;
}
