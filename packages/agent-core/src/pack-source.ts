/**
 * pack-source — collect an agent's raw source into a gzipped tar for upload
 * (AGENT-289).
 *
 * The git-free replacement for the synthesized-tree push in `deploy.ts`. Two
 * properties from the old path are deliberately preserved, because losing either
 * would change what customers actually run:
 *
 *  1. **Pinned dependency versions.** `bundleForDeploy` resolved every external
 *     package to the version installed in the author's tree and shipped that as a
 *     generated `package.json`. Sending the author's own package.json instead
 *     would ship RANGES, so the server's `npm install` could resolve a different
 *     version than the author developed against. The synthesis is kept.
 *
 *  2. **Knowing which files matter.** esbuild's metafile lists exactly the files
 *     the entry actually reaches, so the archive is the real dependency set
 *     rather than a directory sweep — no `node_modules`, no stray scratch files,
 *     nothing that merely happens to sit nearby.
 *
 * What is NOT yet supported, and fails loudly rather than silently: source that
 * reaches OUTSIDE the project directory (a shared `kit/` a level up). esbuild
 * inlined those into one file for the push path, but a raw archive cannot —
 * relative imports must still resolve after extraction, and the server looks for
 * the entry at the archive root. Supporting it needs the entry path to travel
 * from config through BuildInput into `build-definition.mjs`; until then this
 * refuses with an explanation instead of producing an archive that builds
 * without the shared code.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as esbuild from "esbuild";

import { AgentOperationError } from "./errors.js";
import { createTarGz, type TarFile } from "./tar.js";

export interface SourcePackage {
  /** The gzipped tar to upload. */
  archive: Buffer;
  /** Archive-relative paths included, for logging and tests. */
  files: string[];
  /** npm dependencies pinned to the author's installed versions. */
  dependencies: Record<string, string>;
  /** Entry file, relative to the archive root. */
  entry: string;
}

/**
 * Manifest naming the entry, read by the server build.
 *
 * Written only when the entry is not `index.ts` at the archive root. Distinct
 * from the author's `sapiom.json`, which is theirs and must not become something
 * the build depends on.
 */
const SOURCE_MANIFEST = ".sapiom-source.json";

/** Never archived: build output, VCS metadata, and installed packages. */
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", "dist", ".turbo"]);

/**
 * Pack `<projectDir>` for upload.
 *
 * Source that lives ABOVE the agent directory is packed too: the archive is
 * rooted at the lowest directory containing everything the entry imports, and the
 * entry is declared relative to that root. Shared code therefore deploys by
 * upload like anything else, instead of falling back to git.
 *
 * Throws `AgentOperationError` — `NO_ENTRY` when there is no `index.ts`,
 * `BUNDLE_FAILED` when the entry cannot be analysed, `UNSUPPORTED_LAYOUT` only
 * when the imports have no common parent short of the filesystem root.
 */
export async function packSource(projectDir: string): Promise<SourcePackage> {
  const root = path.resolve(projectDir);
  const entryFile = path.join(root, "index.ts");
  if (!existsSync(entryFile)) {
    throw new AgentOperationError({
      code: "NO_ENTRY",
      message: `No index.ts found in ${projectDir}.`,
      hint: "Run this from an agent project, or pass its directory.",
    });
  }

  const { inputs, dependencies } = await analyse(root, entryFile);

  // Where the archive is rooted. Normally the agent directory; when the agent
  // imports shared code from above it, the lowest directory that contains
  // everything the entry reaches. Only the files esbuild actually named are
  // packed either way — a higher root makes paths longer, never the archive
  // bigger.
  const absoluteInputs = inputs.map((input) => path.resolve(root, input));
  const packRoot = resolvePackRoot(root, absoluteInputs);

  const files: TarFile[] = [];
  for (const absolute of absoluteInputs) {
    const relative = path.relative(packRoot, absolute);
    if (relative.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
    files.push({ path: toPosix(relative), content: readFileSync(absolute, "utf8") });
  }

  // The generated manifest, not the author's: exact versions, so the server
  // installs precisely what they developed against.
  files.push({
    path: "package.json",
    content:
      JSON.stringify(
        { name: "sapiom-agent-source", private: true, type: "module", dependencies },
        null,
        2,
      ) + "\n",
  });

  // Declare the entry ONLY when it is not `index.ts` at the archive root. The
  // build falls back to that name, so staying silent in the common case keeps
  // every existing agent's archive byte-identical — and therefore its digest
  // stable, so redeploying unchanged code still stores nothing.
  const entry = toPosix(path.relative(packRoot, entryFile));
  if (entry !== "index.ts") {
    files.push({ path: SOURCE_MANIFEST, content: JSON.stringify({ entry }, null, 2) + "\n" });
  }

  return { archive: createTarGz(files), files: files.map((f) => f.path).sort(), dependencies, entry };
}

/**
 * The directory the archive is rooted at.
 *
 * Never deeper than the agent directory, so an agent whose files all sit in a
 * subfolder keeps the layout it has today. Higher only when something the entry
 * imports lives above the agent directory.
 */
function resolvePackRoot(projectDir: string, absoluteInputs: string[]): string {
  const ancestor = commonAncestor(absoluteInputs);
  if (ancestor === projectDir || ancestor.startsWith(projectDir + path.sep)) return projectDir;
  if (ancestor === path.parse(ancestor).root) {
    // Nothing shy of the filesystem root contains every input — two unrelated
    // trees, or a symlink out. Packing from `/` would be absurd, so this stays a
    // hard error rather than something the deploy silently does.
    throw new AgentOperationError({
      code: "UNSUPPORTED_LAYOUT",
      message: "This agent's imports span unrelated directories, with no common parent short of the filesystem root.",
      hint: "Keep the agent and the code it imports under one project directory.",
    });
  }
  return ancestor;
}

/** Lowest directory containing every given file. */
function commonAncestor(absolutePaths: string[]): string {
  const segmentLists = absolutePaths.map((p) => path.dirname(p).split(path.sep));
  const first = segmentLists[0] ?? [];
  let shared = first.length;
  for (const segments of segmentLists.slice(1)) {
    let i = 0;
    while (i < shared && i < segments.length && segments[i] === first[i]) i += 1;
    shared = i;
  }
  return first.slice(0, shared).join(path.sep) || path.sep;
}

/**
 * Run esbuild purely for its metafile: which files the entry reaches, and which
 * npm packages stay external. Output is discarded — only the analysis is wanted.
 */
async function analyse(
  root: string,
  entryFile: string,
): Promise<{ inputs: string[]; dependencies: Record<string, string> }> {
  const tmp = mkdtempSync(path.join(tmpdir(), "sapiom-pack-source-"));
  try {
    let result: esbuild.BuildResult;
    try {
      result = await esbuild.build({
        entryPoints: [entryFile],
        outfile: path.join(tmp, "index.js"),
        // Anchored to the project for the same reason as `bundleForDeploy`: with
        // no working directory of its own, esbuild also walks OUR cwd's ancestors,
        // and the harness calls this in-process from deep inside its app bundle.
        absWorkingDir: root,
        bundle: true,
        platform: "node",
        target: "node20",
        format: "esm",
        packages: "external",
        metafile: true,
        logLevel: "silent",
      });
    } catch (err) {
      throw new AgentOperationError({
        code: "BUNDLE_FAILED",
        message: "Failed to analyse the agent's source for packing.",
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    const metafile = result.metafile!;
    return {
      // Metafile keys are relative to esbuild's working directory, which is the
      // project root — not this process's cwd.
      inputs: Object.keys(metafile.inputs),
      dependencies: resolveInstalledVersions(root, externalPackagesOf(metafile)),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Packages left external, read from the INPUT graph rather than the output's
 * import list.
 *
 * `bundleForDeploy` reads `outputs[].imports`, which is right for a single
 * emitted file. Reading the inputs is equivalent here and does not depend on
 * matching the output key back to the outfile path.
 */
function externalPackagesOf(metafile: esbuild.Metafile): string[] {
  const names = new Set<string>();
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports) {
      if (!imported.external) continue;
      const name = packageNameOf(imported.path);
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** `zod/v4` → `zod`; `@sapiom/agent/x` → `@sapiom/agent`; a builtin → null. */
function packageNameOf(importPath: string): string | null {
  if (importPath.startsWith("node:")) return null;
  const parts = importPath.split("/");
  if (importPath.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

/** Exact installed version per package, walking up like Node resolution. */
function resolveInstalledVersions(
  fromDir: string,
  packages: readonly string[],
): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const pkg of packages) deps[pkg] = readInstalledVersion(fromDir, pkg) ?? "latest";
  return deps;
}

function readInstalledVersion(fromDir: string, pkg: string): string | null {
  let dir = path.resolve(fromDir);
  for (;;) {
    const manifest = path.join(dir, "node_modules", ...pkg.split("/"), "package.json");
    if (existsSync(manifest)) {
      try {
        const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
        if (version) return version;
      } catch {
        // unreadable — keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** tar paths are always POSIX, even when built on Windows. */
function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}
