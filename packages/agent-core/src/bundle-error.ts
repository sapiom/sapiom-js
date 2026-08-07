/**
 * bundle-error — turn esbuild's raw bundle failure into an actionable hint.
 *
 * The Canvas render, `check`, and `run_local` all esbuild-bundle a project's
 * `index.ts` resolving its imports from the project's own `node_modules`. By
 * far the most common failure is "Could not resolve …" against a project whose
 * dependencies were simply never installed (a fresh clone, or a scaffold whose
 * install was skipped/failed). Relaying esbuild's raw message — a wall of
 * "Could not resolve \"@sapiom/agent\" … Could not resolve \"zod\"" with deep
 * relative paths — leaves the user staring at noise. This maps that exact case
 * to a one-line instruction, while preserving the original detail for any other
 * bundle failure (a genuine bad import, a syntax error).
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Describe an esbuild bundle failure for `sourceDir`. When the project has no
 * `node_modules` and esbuild reported an unresolved import, returns an
 * actionable "run npm install" hint (with the raw detail appended). Otherwise
 * returns the raw error message unchanged.
 */
export function describeBundleFailure(sourceDir: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const nodeModules = path.join(sourceDir, "node_modules");
  if (!existsSync(nodeModules) && /Could not resolve/.test(raw)) {
    return (
      `Dependencies are not installed. Run \`npm install\` in ${sourceDir}, then try again. ` +
      `(esbuild: ${raw})`
    );
  }
  return raw;
}
