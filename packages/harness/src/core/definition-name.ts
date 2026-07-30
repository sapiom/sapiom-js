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
import { extractWorkflowGraphCached } from "./canvas-cache.js";

export async function resolveManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
): Promise<string | null> {
  try {
    const { result } = await extract(projectDir);
    if (!result.ok) return null;
    return result.graph.manifestName.trim() || null;
  } catch {
    // Extraction is best-effort here — a name is a nicety, a deploy is not.
    return null;
  }
}
