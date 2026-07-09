/**
 * Heuristic cross-workflow launch detection: greps a workflow project's
 * TypeScript sources for `orchestrations.launch({ definition: "<slug>" })`
 * (the pre-rename SDK's capability) and `agents.launch({ definition: ... })`
 * (the current SDK, e.g. `ctx.sapiom.agents.launch`) calls, and best-effort
 * attributes each call to the step whose `defineStep({ name: ... })` block it
 * sits in. The result is merged into the workflow's own rendered graph as
 * dashed "launched workflow" nodes (see core/canvas-graph.ts).
 *
 * This is deliberately a grep, not a type-aware analysis — a step can compute
 * its `definition` dynamically, in which case it's simply not detected; false
 * negatives are fine here, the launch nodes are a bonus, not a source of
 * truth.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".sapiom"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const MAX_FILES_PER_WORKFLOW = 200;
const MAX_FILE_BYTES = 512 * 1024;

// Matches `orchestrations.launch({ ...definition: "slug"... })` (old SDK) and
// `agents.launch({ ...definition: "slug"... })` (current SDK), tolerating
// other fields before `definition` in the object literal (bounded lookahead
// so an unrelated huge object literal can't make this pathological).
const LAUNCH_CALL_PATTERN =
  /(?:orchestrations|agents)\s*\.\s*launch\s*\(\s*\{[\s\S]{0,400}?definition\s*:\s*(['"`])([^'"`]+)\1/g;

// A `name: "..."` property declaration — the step-name key `defineStep`
// blocks always open with. The lookbehind rejects longer identifiers ending
// in "name" (fromName, vendorName) without consuming the preceding char.
const STEP_NAME_PATTERN = /(?<![\w$.])name\s*:\s*(['"`])([^'"`]+)\1/g;

/**
 * Lists the workflow's own `.ts`/`.tsx` sources (skipping node_modules and
 * friends), bounded to MAX_FILES_PER_WORKFLOW. Shared with the extraction
 * cache's source fingerprint (core/canvas-cache.ts) so "the files this grep
 * reads" and "the files whose mtimes invalidate the cache" can't drift.
 */
export async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES_PER_WORKFLOW) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_WORKFLOW) return;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return files;
}

export interface DetectedLaunch {
  /** The `definition` slug the launch call referenced. */
  slug: string;
  /** The step (by declared name) the call was attributed to — the nearest
   *  preceding `name: "<known step>"` declaration in the same file — or null
   *  when no known step precedes it (e.g. a launch in a shared helper). */
  fromStepId: string | null;
}

/**
 * Every `*.launch({ definition: "..." })` call in `root`'s sources, each
 * best-effort attributed to the step whose `defineStep` block it sits in
 * (`knownStepIds` = the workflow's real step names, so an unrelated `name:`
 * property can never be mistaken for a step). Never throws: unreadable
 * files/directories simply contribute no launches.
 */
export async function detectWorkflowLaunches(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<DetectedLaunch[]> {
  const launches: DetectedLaunch[] = [];
  for (const file of await listSourceFiles(root)) {
    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const stepDeclarations: Array<{ index: number; stepId: string }> = [];
    for (const match of content.matchAll(STEP_NAME_PATTERN)) {
      if (knownStepIds.has(match[2]!)) stepDeclarations.push({ index: match.index, stepId: match[2]! });
    }

    for (const match of content.matchAll(LAUNCH_CALL_PATTERN)) {
      const preceding = stepDeclarations.filter((d) => d.index < match.index).at(-1);
      launches.push({ slug: match[2]!, fromStepId: preceding?.stepId ?? null });
    }
  }
  return launches;
}
