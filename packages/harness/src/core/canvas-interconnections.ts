/**
 * Heuristic cross-workflow interconnection detection for the workspace
 * overview render: greps every workflow project's TypeScript sources for
 * `orchestrations.launch({ definition: "<slug>" })` calls (see
 * @sapiom/tools's `orchestrations` capability) and matches the captured slug
 * against the other workflows' own manifest names. This is deliberately a
 * grep, not a type-aware analysis — a step can compute its `definition`
 * dynamically, in which case it's simply not detected; false negatives are
 * fine here, this panel is a bonus overview, not a source of truth.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".sapiom"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const MAX_FILES_PER_WORKFLOW = 200;
const MAX_FILE_BYTES = 512 * 1024;

// Matches `orchestrations.launch({ ...definition: "slug"... })`, tolerating
// other fields before `definition` in the object literal (bounded lookahead
// so an unrelated huge object literal can't make this pathological).
const LAUNCH_CALL_PATTERN = /orchestrations\s*\.\s*launch\s*\(\s*\{[\s\S]{0,400}?definition\s*:\s*(['"`])([^'"`]+)\1/g;

async function listSourceFiles(root: string): Promise<string[]> {
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

/** Every `orchestrations.launch({ definition: "..." })` slug referenced anywhere in `root`. */
async function launchedSlugs(root: string): Promise<string[]> {
  const slugs: string[] = [];
  for (const file of await listSourceFiles(root)) {
    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(LAUNCH_CALL_PATTERN)) {
      slugs.push(match[2]);
    }
  }
  return slugs;
}

export interface InterconnectionEdge {
  fromManifestName: string;
  /** The other workflow's manifest name, or null when the slug doesn't match any known workflow. */
  toManifestName: string | null;
  /** The raw slug the source referenced — shown when `toManifestName` is null. */
  toSlug: string;
}

/**
 * Scans every workflow's sources for `orchestrations.launch` calls and
 * resolves each target slug against the other workflows in `workflows`
 * (matched by manifest name — the value `defineAgent({ name })` sets, not
 * the directory/package.json name `WorkflowInfo.name` carries). Best-effort:
 * a workflow whose sources can't be read simply contributes no edges.
 */
export async function detectInterconnections(
  workflows: readonly { path: string; manifestName: string }[],
): Promise<InterconnectionEdge[]> {
  const byName = new Map(workflows.map((w) => [w.manifestName, w.manifestName]));
  const edges: InterconnectionEdge[] = [];
  for (const workflow of workflows) {
    const slugs = await launchedSlugs(workflow.path);
    for (const slug of slugs) {
      edges.push({
        fromManifestName: workflow.manifestName,
        toManifestName: byName.get(slug) ?? null,
        toSlug: slug,
      });
    }
  }
  return edges;
}
