/**
 * bundle-for-deploy — collapse an orchestration's LOCAL/relative code into a
 * single self-contained `index.ts`, while leaving npm packages external.
 *
 * This is what lets a definition import shared local utils (relative imports,
 * not published packages) and still deploy: esbuild inlines everything reachable
 * by relative path — including shared files outside the definition's own folder,
 * e.g. `import { fmt } from "../../shared/format.js"` in a monorepo — so the
 * pushed source no longer references anything above the repo root.
 *
 * npm packages are deliberately kept EXTERNAL (`packages: 'external'`) and
 * surfaced as a synthesized dependency list (pinned to the author's installed
 * versions). The server install resolves them at build time — so third-party
 * deps and the `@sapiom/*` SDK are still installed server-side (bring-your-own-
 * deps), not frozen into the bundle.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as esbuild from 'esbuild';

import { AgentOperationError } from './errors.js';

export interface DeployBundle {
  /** The bundled `index.ts` source (relative code inlined, npm imports external). */
  code: string;
  /** npm dependencies the bundle imports, pinned to the author's installed versions. */
  dependencies: Record<string, string>;
}

/**
 * Bundle `<sourceDir>/index.ts`, inlining relative imports and externalizing npm
 * packages, then resolve each external package to the version installed in the
 * author's tree. Throws `AgentOperationError` (`NO_ENTRY` | `BUNDLE_FAILED`).
 */
export async function bundleForDeploy(sourceDir: string): Promise<DeployBundle> {
  const entryFile = path.join(sourceDir, 'index.ts');
  if (!existsSync(entryFile)) {
    throw new AgentOperationError({
      code: 'NO_ENTRY',
      message: `No index.ts found in ${sourceDir}.`,
      hint: 'Run this from an orchestration project, or pass its directory.',
    });
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'sapiom-deploy-bundle-'));
  const outfile = path.join(tmp, 'index.js');
  try {
    let result: esbuild.BuildResult;
    try {
      result = await esbuild.build({
        entryPoints: [entryFile],
        outfile,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        // Inline relative/local code; keep every npm package import external so the
        // server install (not this bundle) provides them.
        packages: 'external',
        metafile: true,
        logLevel: 'silent',
      });
    } catch (err) {
      throw new AgentOperationError({
        code: 'BUNDLE_FAILED',
        message: 'Failed to bundle the orchestration for deploy.',
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    const code = readFileSync(outfile, 'utf8');
    const externals = collectExternalPackages(result.metafile!, outfile);
    const dependencies = resolveInstalledVersions(sourceDir, externals);
    return { code, dependencies };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The npm package names left external in the bundle (Node built-ins excluded).
 * A subpath import (`zod/v4`, `@scope/pkg/sub`) is reduced to its package name.
 */
function collectExternalPackages(metafile: esbuild.Metafile, outfile: string): string[] {
  const key = Object.keys(metafile.outputs).find((k) => path.resolve(k) === path.resolve(outfile));
  const imports = key ? metafile.outputs[key].imports : [];
  const names = new Set<string>();
  for (const imp of imports) {
    if (!imp.external) continue;
    const name = packageNameOf(imp.path);
    if (name && !isBuiltin(name)) names.add(name);
  }
  return [...names].sort();
}

/** `zod/v4` → `zod`; `@sapiom/orchestration/x` → `@sapiom/orchestration`. */
function packageNameOf(importPath: string): string | null {
  if (importPath.startsWith('node:')) return null;
  const parts = importPath.split('/');
  if (importPath.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

/**
 * Resolve each package to the version installed in the author's tree (walking up
 * from `sourceDir` like Node resolution), pinned exactly so the server build
 * installs precisely what the author developed against. A package with no
 * installed copy is recorded as `latest` (the server install will resolve it).
 */
function resolveInstalledVersions(sourceDir: string, packages: string[]): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const pkg of packages) {
    deps[pkg] = readInstalledVersion(sourceDir, pkg) ?? 'latest';
  }
  return deps;
}

function readInstalledVersion(fromDir: string, pkg: string): string | null {
  let dir = path.resolve(fromDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pkgJson = path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const version = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }).version;
        if (version) return version;
      } catch {
        // unreadable — fall through to keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
