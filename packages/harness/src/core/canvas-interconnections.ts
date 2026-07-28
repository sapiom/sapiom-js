/**
 * Heuristic scan of a workflow project's TypeScript sources for two things the
 * canvas surfaces, in a single pass:
 *
 *  - cross-workflow launches — `orchestrations.launch({ definition: "<slug>" })`
 *    (old SDK) and `agents.launch({ definition: ... })` (current SDK), rendered
 *    as dashed "launched workflow" nodes; and
 *  - Sapiom capabilities — `ctx.sapiom.<ns>.<method>(...)` call sites, rendered
 *    as capability chips on the step (the thing Sapiom bills for).
 *
 * Each call is attributed to the step whose `defineStep({ ... })` block it
 * literally sits inside — a brace-balanced extent, not merely the nearest
 * preceding `name:`. A call in a shared helper (or anywhere outside a step
 * block) is left unattributed (`fromStepId: null`) rather than mis-billed to
 * the last step in the file — for a capability chip that would read as a false
 * claim about what a step calls.
 *
 * This is deliberately a grep, not a type-aware analysis — a step can compute
 * its `definition`/call dynamically, in which case it's simply not detected;
 * false negatives are fine here.
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

// Matches `sapiom.<ns>.<method>(` chains — e.g. `ctx.sapiom.web.search(`,
// `sapiom.email.messages.send(`. Captures the dotted chain AFTER `sapiom.`
// (the capability id: "web.search", "email.messages.send"), tolerating
// whitespace around the dots. The negative lookbehind avoids matching an
// identifier that merely ends in "sapiom".
const CAPABILITY_CALL_PATTERN =
  /(?<![\w$])sapiom\s*\.\s*([a-z][\w$]*(?:\s*\.\s*[a-z][\w$]*)+)\s*\(/gi;

// Launch calls are surfaced as dashed launched-workflow nodes, not capabilities.
const NON_CAPABILITY_CALLS = new Set(["agents.launch", "orchestrations.launch"]);

// A `name: "..."` property declaration — the step-name key `defineStep`
// blocks always open with. The lookbehind rejects longer identifiers ending
// in "name" (fromName, vendorName) without consuming the preceding char.
const STEP_NAME_PATTERN = /(?<![\w$.])name\s*:\s*(['"`])([^'"`]+)\1/g;

// A `defineStep(` call opener (not `myDefineStep(`). Its brace-balanced extent
// is what bounds a step's attribution below.
const DEFINE_STEP_PATTERN = /(?<![\w$.])defineStep\s*\(/g;

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

// --- attribution: which step's defineStep(...) block a call sits in ---------

/** From the opening quote at `open`, the index of the matching close quote (or
 *  the last index). Escapes are honored; a template literal is treated as one
 *  opaque span (its balanced `${…}` parens never leak into the paren count). */
function skipString(content: string, open: number): number {
  const quote = content[open];
  for (let i = open + 1; i < content.length; i++) {
    if (content[i] === "\\") {
      i++;
      continue;
    }
    if (content[i] === quote) return i;
  }
  return content.length - 1;
}

/** From the `(` at `open`, the index of its matching `)` (or end of file),
 *  skipping string and comment content so parens inside them can't miscount. */
function matchingParen(content: string, open: number): number {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const c = content[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(content, i);
      continue;
    }
    if (c === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      if (nl === -1) return content.length;
      i = nl;
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      const close = content.indexOf("*/", i + 2);
      i = close === -1 ? content.length : close + 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return content.length;
}

interface StepBlock {
  /** Index of the `(` opening the `defineStep(` call. */
  start: number;
  /** Index of the matching `)`. */
  end: number;
  /** The known step this block declares (its first known `name:`). */
  stepId: string;
}

/** The brace-balanced extent of each `defineStep(...)` call whose declared
 *  `name` is a known step — so a call can be attributed to the step it sits in,
 *  not the nearest preceding `name:` (which mis-binds trailing helpers). */
function stepBlockRanges(content: string, knownStepIds: ReadonlySet<string>): StepBlock[] {
  const blocks: StepBlock[] = [];
  for (const match of content.matchAll(DEFINE_STEP_PATTERN)) {
    const open = match.index + match[0].length - 1; // the `(` of defineStep(
    const end = matchingParen(content, open);
    let stepId: string | null = null;
    for (const nameMatch of content.slice(open, end).matchAll(STEP_NAME_PATTERN)) {
      if (knownStepIds.has(nameMatch[2]!)) {
        stepId = nameMatch[2]!;
        break;
      }
    }
    if (stepId) blocks.push({ start: open, end, stepId });
  }
  return blocks;
}

/** The step whose block contains `index`, or null (top-level / shared helper). */
function attributeTo(blocks: readonly StepBlock[], index: number): string | null {
  for (const block of blocks) {
    if (index > block.start && index < block.end) return block.stepId;
  }
  return null;
}

export interface DetectedLaunch {
  /** The `definition` slug the launch call referenced. */
  slug: string;
  /** The step (by declared name) the call was attributed to — the step whose
   *  `defineStep` block it sits in — or null when it sits outside any step
   *  (e.g. a launch in a shared helper). */
  fromStepId: string | null;
}

export interface DetectedCapability {
  /** The dotted capability id (e.g. "web.search", "email.messages.send"). */
  capability: string;
  /** The step the call was attributed to, or null (a shared helper). */
  fromStepId: string | null;
}

export interface WorkflowSourceScan {
  launches: DetectedLaunch[];
  capabilities: DetectedCapability[];
}

/**
 * One pass over `root`'s sources returning both the cross-workflow launches and
 * the Sapiom capability calls, each attributed to the `defineStep` block it
 * sits in (`knownStepIds` = the workflow's real step names, so an unrelated
 * `name:` property can never be mistaken for a step). Never throws: unreadable
 * files/directories simply contribute nothing.
 *
 * A single walk + read + block computation per file: the callers used to scan
 * the tree twice (once per detector), and auto-render now fires on every save,
 * so the shared pass halves the I/O on the hot path.
 */
export async function scanWorkflowSources(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<WorkflowSourceScan> {
  const launches: DetectedLaunch[] = [];
  const capabilities: DetectedCapability[] = [];
  for (const file of await listSourceFiles(root)) {
    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const blocks = stepBlockRanges(content, knownStepIds);

    for (const match of content.matchAll(LAUNCH_CALL_PATTERN)) {
      launches.push({ slug: match[2]!, fromStepId: attributeTo(blocks, match.index) });
    }
    for (const match of content.matchAll(CAPABILITY_CALL_PATTERN)) {
      const capability = match[1]!.replace(/\s+/g, "");
      if (NON_CAPABILITY_CALLS.has(capability)) continue;
      capabilities.push({ capability, fromStepId: attributeTo(blocks, match.index) });
    }
  }
  return { launches, capabilities };
}

/** Just the launches from {@link scanWorkflowSources}. */
export async function detectWorkflowLaunches(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<DetectedLaunch[]> {
  return (await scanWorkflowSources(root, knownStepIds)).launches;
}

/** Just the capabilities from {@link scanWorkflowSources}. */
export async function detectStepCapabilities(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<DetectedCapability[]> {
  return (await scanWorkflowSources(root, knownStepIds)).capabilities;
}
