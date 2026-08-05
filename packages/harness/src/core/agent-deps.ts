/**
 * One shared notion of "this agent project's dependencies are installed",
 * used by both the render pipeline (core/canvas-render.ts — decides whether to
 * extract or show the "preparing" placeholder) and the install watcher
 * (core/install-watcher.ts — decides when to re-render). Keeping the probe in
 * one place stops those two from disagreeing about readiness, which would
 * either flash the esbuild error or never re-render.
 *
 * "Ready" means EVERY runtime dependency the bundle imports is resolvable —
 * the project's declared `dependencies` (e.g. `@sapiom/agent`, `@sapiom/tools`,
 * `zod`), each found by walking `node_modules` up the directory tree exactly as
 * Node/esbuild module resolution does. Three things this gets right:
 *
 *   - Requiring ALL declared deps, not just the SDK, closes the partial-install
 *     window. `npm install` writes packages incrementally, so `@sapiom/agent`
 *     can land before `zod`; keying on the SDK alone would let the watcher
 *     re-render into a `Could not resolve "zod/v4"` failure — the very error
 *     we're hiding. The graph appears only once the bundle can actually
 *     succeed. (devDependencies — typescript, prettier — don't affect the
 *     type-stripped bundle, so they're intentionally not required.)
 *   - Checking each package's `package.json` (not just its directory) means a
 *     dir npm created but hasn't populated yet still reads as "not ready".
 *   - Walking UP resolves deps hoisted to a parent `node_modules` (a monorepo
 *     checkout, the repo's own example fixtures), matching what the bundle can
 *     resolve; a standalone fresh scaffold has no such ancestor, so it reads as
 *     "preparing" until its own `npm install` lands.
 *
 * If `package.json` can't be read (a fixture without one), it falls back to the
 * SDK package every agent project imports — never crashing the render on it.
 */
import { existsSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** The SDK package every agent project imports — the fallback probe when a
 *  project's package.json can't be read, and the source of the canonical
 *  `Could not resolve "@sapiom/agent"` error on a fresh scaffold. */
export const AGENT_SDK_PACKAGE = "@sapiom/agent";

/** The `node_modules/<pkg>/package.json` candidate at each ancestor of
 *  `projectDir` — the search path Node/esbuild walk to resolve a bare import. */
function manifestCandidates(projectDir: string, pkg: string): string[] {
  const candidates: string[] = [];
  let dir = path.resolve(projectDir);
  for (;;) {
    candidates.push(path.join(dir, "node_modules", pkg, "package.json"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/** The runtime deps the bundle must resolve: the project's declared
 *  `dependencies` keys, or the SDK alone if package.json is missing/unreadable. */
function requiredDeps(projectDir: string): string[] {
  try {
    const raw = readFileSync(path.join(projectDir, "package.json"), "utf8");
    const deps = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies;
    const names = deps ? Object.keys(deps) : [];
    return names.length > 0 ? names : [AGENT_SDK_PACKAGE];
  } catch {
    return [AGENT_SDK_PACKAGE];
  }
}

function resolvesSync(projectDir: string, pkg: string): boolean {
  return manifestCandidates(projectDir, pkg).some((c) => existsSync(c));
}

async function resolvesAsync(projectDir: string, pkg: string): Promise<boolean> {
  for (const candidate of manifestCandidates(projectDir, pkg)) {
    const found = await fsp
      .access(candidate)
      .then(() => true)
      .catch(() => false);
    if (found) return true;
  }
  return false;
}

/** Async readiness probe for the render pipeline — true iff every declared
 *  runtime dependency resolves. */
export async function agentDepsInstalled(projectDir: string): Promise<boolean> {
  for (const dep of requiredDeps(projectDir)) {
    if (!(await resolvesAsync(projectDir, dep))) return false;
  }
  return true;
}

/** Sync readiness probe for the install watcher's poll loop. */
export function agentDepsInstalledSync(projectDir: string): boolean {
  return requiredDeps(projectDir).every((dep) => resolvesSync(projectDir, dep));
}
