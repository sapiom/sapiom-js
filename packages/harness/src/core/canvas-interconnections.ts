/**
 * Heuristic scan of a workflow project's TypeScript sources for two things the
 * canvas surfaces, in a single pass:
 *
 *  - direct cross-agent invocations — current `agents.run` / `agents.launch`
 *    calls and the supported legacy `orchestrations.launch` form, extracted
 *    with a syntax-only TypeScript walk; and
 *  - Sapiom capabilities — `ctx.sapiom.<ns>.<method>(...)` call sites, rendered
 *    as capability chips on the step (usually the thing Sapiom bills for;
 *    `agents.run` remains temporarily for per-agent Canvas compatibility).
 *
 * Each call is attributed to the step whose `defineStep({ ... })` block it
 * literally sits inside — a brace-balanced extent, not merely the nearest
 * preceding `name:`. A call in a shared helper (or anywhere outside a step
 * block) is left unattributed (`fromStepId: null`) rather than mis-billed to
 * the last step in the file — for a capability chip that would read as a false
 * claim about what a step calls.
 *
 * This deliberately does not create a Program or TypeChecker. Supported direct
 * calls are syntax-accurate (comments and strings cannot become invocations),
 * while dynamic targets are returned as explicit extraction warnings.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

import type { AgentInvocationMode } from "../shared/system-graph.js";

export type { AgentInvocationMode } from "../shared/system-graph.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".sapiom",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
export const RELATIONSHIP_SCAN_MAX_FILES = 200;
export const RELATIONSHIP_SCAN_MAX_DIRECTORIES = 2_000;
export const RELATIONSHIP_SCAN_MAX_DEPTH = 16;
export const RELATIONSHIP_SCAN_MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 512 * 1024;

// Matches `sapiom.<ns>.<method>(` chains — e.g. `ctx.sapiom.web.search(`,
// `sapiom.email.messages.send(`. Captures the dotted chain AFTER `sapiom.`
// (the capability id: "web.search", "email.messages.send"), tolerating
// whitespace around the dots. The negative lookbehind avoids matching an
// identifier that merely ends in "sapiom".
const CAPABILITY_CALL_PATTERN =
  /(?<![\w$])sapiom\s*\.\s*([a-z][\w$]*(?:\s*\.\s*[a-z][\w$]*)+)\s*\(/gi;

// Async launches already render as launched-agent nodes on the per-agent
// Canvas. Keep blocking `agents.run` in that Canvas's existing capability-chip
// projection until it gains a blocking invocation node of its own.
const NON_CAPABILITY_CALLS = new Set([
  "agents.launch",
  "orchestrations.launch",
]);

/** Most workflow files contain no cross-agent API at all. Avoid constructing a
 * TypeScript tree for that hot path while keeping every supported spelling. */
function mayContainAgentInvocation(content: string): boolean {
  return content.includes("agents") || content.includes("orchestrations");
}

// A `name: "..."` property declaration — the step-name key `defineStep`
// blocks always open with. The lookbehind rejects longer identifiers ending
// in "name" (fromName, vendorName) without consuming the preceding char.
const STEP_NAME_PATTERN = /(?<![\w$.])name\s*:\s*(['"`])([^'"`]+)\1/g;

// A `defineStep(` call opener (not `myDefineStep(`). Its brace-balanced extent
// is what bounds a step's attribution below.
const DEFINE_STEP_PATTERN = /(?<![\w$.])defineStep\s*\(/g;

/**
 * Lists the workflow's own TypeScript sources (skipping node_modules and
 * friends), bounded by fixed file, directory, entry, and depth limits. Shared with the extraction
 * cache's source fingerprint (core/canvas-cache.ts) so "the files this grep
 * reads" and "the files whose mtimes invalidate the cache" can't drift.
 */
export interface WorkflowSourceFileSet {
  files: string[];
  /** Directories plus candidate files whose metadata defines membership. */
  observedPaths: string[];
  /** False when an opaque path or a deterministic work cap hid sources. */
  complete: boolean;
}

export interface WorkflowSourceWalkLimits {
  maxFiles?: number;
  maxDirectories?: number;
  maxDepth?: number;
  maxEntries?: number;
}

export async function listSourceFilesWithObservations(
  root: string,
  limits: WorkflowSourceWalkLimits = {},
): Promise<WorkflowSourceFileSet> {
  const absoluteRoot = path.resolve(root);
  const files: string[] = [];
  const observedPaths: string[] = [];
  const pending: Array<{ dir: string; depth: number }> = [
    { dir: absoluteRoot, depth: 0 },
  ];
  let directories = 0;
  let entriesVisited = 0;
  let complete = true;
  const maxFiles = Math.max(1, limits.maxFiles ?? RELATIONSHIP_SCAN_MAX_FILES);
  const maxDirectories = Math.max(
    1,
    limits.maxDirectories ?? RELATIONSHIP_SCAN_MAX_DIRECTORIES,
  );
  const maxDepth = Math.max(0, limits.maxDepth ?? RELATIONSHIP_SCAN_MAX_DEPTH);
  const maxEntries = Math.max(
    1,
    limits.maxEntries ?? RELATIONSHIP_SCAN_MAX_ENTRIES,
  );

  while (pending.length > 0) {
    if (directories >= maxDirectories) {
      complete = false;
      break;
    }
    const current = pending.shift()!;
    const { dir, depth } = current;
    const entries: import("node:fs").Dirent[] = [];
    let directoryTruncated = false;
    try {
      const directory = await fs.opendir(dir);
      try {
        const remainingEntries = maxEntries - entriesVisited;
        for (let index = 0; index < remainingEntries; index += 1) {
          const entry = await directory.read();
          if (!entry) break;
          entries.push(entry);
          entriesVisited += 1;
        }
        // Do not perform an unbounded count merely to distinguish exactly-at-
        // cap from over-cap. Treat the boundary conservatively as incomplete;
        // the containing directory metadata still detects membership changes.
        if (entriesVisited >= maxEntries) {
          complete = false;
          directoryTruncated = true;
        }
      } finally {
        await directory.close().catch(() => {});
      }
    } catch {
      complete = false;
      continue;
    }
    directories += 1;
    observedPaths.push(dir);
    if (directoryTruncated) {
      // Filesystem directory iteration order is not portable. Never project a
      // cap-sized prefix whose membership could differ across hosts/passes;
      // keep the containing directory observation and discard this partial
      // directory atomically.
      entries.length = 0;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (
      dir !== absoluteRoot &&
      entries.some((entry) => entry.name === ".git")
    ) {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (depth >= maxDepth) {
          complete = false;
          continue;
        }
        pending.push({ dir: candidate, depth: depth + 1 });
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          complete = false;
          continue;
        }
        if (files.length >= maxFiles) {
          complete = false;
          continue;
        }
        files.push(candidate);
        observedPaths.push(candidate);
      } else if (entry.isSymbolicLink()) {
        // A symlink may hide a directory of project sources. Never follow it,
        // and keep the invocation projection explicitly degraded.
        complete = false;
      }
    }
    if (entriesVisited >= maxEntries) break;
  }
  return { files, observedPaths, complete };
}

export async function listSourceFiles(root: string): Promise<string[]> {
  return (await listSourceFilesWithObservations(root)).files;
}

export interface WorkflowSourceReadHooks {
  /** Deterministic race seam after initial admission but before open. */
  beforeOpen?: (file: string) => void | Promise<void>;
  /** Called only after bytes were read from the admitted opened handle. */
  onBytesRead?: (file: string, bytes: number) => void;
}

export interface WorkflowSourceFileMetadata {
  status: "regular" | "directory" | "absent" | "unreadable" | "inadmissible";
  size?: number;
  mtimeMs?: number;
  dev?: number;
  ino?: number;
}

function confinedSourceFile(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function admittedSourceAncestors(
  root: string,
  file: string,
): Promise<boolean> {
  if (!confinedSourceFile(root, file)) return false;
  const relativeDirectory = path.relative(root, path.dirname(file));
  let current = root;
  for (const segment of [
    "",
    ...relativeDirectory.split(path.sep).filter(Boolean),
  ]) {
    if (segment) current = path.join(current, segment);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(current);
    } catch {
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (current === root) continue;
    try {
      await fs.lstat(path.join(current, ".git"));
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return false;
    }
  }
  return true;
}

/** Metadata-only, no-follow admission used by cache and watcher fingerprints. */
export async function workflowSourceFileMetadata(
  root: string,
  file: string,
): Promise<WorkflowSourceFileMetadata> {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(file);
  if (absoluteFile === absoluteRoot) {
    try {
      const stat = await fs.lstat(absoluteRoot);
      return stat.isDirectory() && !stat.isSymbolicLink()
        ? {
            status: "directory",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            dev: stat.dev,
            ino: stat.ino,
          }
        : { status: "inadmissible" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        status:
          code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable",
      };
    }
  }
  if (!(await admittedSourceAncestors(absoluteRoot, absoluteFile))) {
    return { status: "inadmissible" };
  }
  try {
    const stat = await fs.lstat(absoluteFile);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      return {
        status: "directory",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: "inadmissible" };
    }
    return {
      status: "regular",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable",
    };
  }
}

function sameOpenedSource(
  expected: WorkflowSourceFileMetadata,
  actual: import("node:fs").Stats,
): boolean {
  return (
    expected.status === "regular" &&
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs
  );
}

/** Bounded opened-handle read that never follows a final or ancestor symlink. */
export async function readWorkflowSourceFile(
  root: string,
  file: string,
  hooks: WorkflowSourceReadHooks = {},
): Promise<string | null> {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(file);
  const admitted = await workflowSourceFileMetadata(absoluteRoot, absoluteFile);
  if (
    admitted.status !== "regular" ||
    (admitted.size ?? MAX_FILE_BYTES + 1) > MAX_FILE_BYTES
  ) {
    return null;
  }
  await hooks.beforeOpen?.(absoluteFile);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(
      absoluteFile,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (
      !sameOpenedSource(admitted, opened) ||
      !(await admittedSourceAncestors(absoluteRoot, absoluteFile))
    ) {
      return null;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_FILE_BYTES) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_FILE_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      hooks.onBytesRead?.(absoluteFile, bytesRead);
      if (total > MAX_FILE_BYTES) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const final = await handle.stat();
    if (
      !sameOpenedSource(admitted, final) ||
      !(await admittedSourceAncestors(absoluteRoot, absoluteFile))
    ) {
      return null;
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
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
function stepBlockRanges(
  content: string,
  knownStepIds: ReadonlySet<string>,
): StepBlock[] {
  const blocks: StepBlock[] = [];
  for (const match of content.matchAll(DEFINE_STEP_PATTERN)) {
    const open = match.index + match[0].length - 1; // the `(` of defineStep(
    const end = matchingParen(content, open);
    let stepId: string | null = null;
    for (const nameMatch of content
      .slice(open, end)
      .matchAll(STEP_NAME_PATTERN)) {
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
function attributeTo(
  blocks: readonly StepBlock[],
  index: number,
): string | null {
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

/** Internal source evidence. It never crosses the system-graph HTTP boundary. */
export interface SourceEvidence {
  /** POSIX path relative to the caller's source root. */
  file: string;
  /** One-based source location of the supported call expression. */
  line: number;
  column: number;
}

export interface DetectedAgentInvocation {
  /** The direct literal `definition` target. */
  slug: string;
  mode: AgentInvocationMode;
  fromStepId: string | null;
  evidence: SourceEvidence;
}

export interface AgentInvocationDetectionWarning {
  code: "dynamic-target";
  mode: AgentInvocationMode;
  evidence: SourceEvidence;
}

export interface AgentInvocationScanResult {
  invocations: DetectedAgentInvocation[];
  warnings: AgentInvocationDetectionWarning[];
  observedPaths: string[];
  complete: boolean;
}

export interface DetectedCapability {
  /** The dotted capability id (e.g. "web.search", "email.messages.send"). */
  capability: string;
  /** The step the call was attributed to, or null (a shared helper). */
  fromStepId: string | null;
}

export interface WorkflowSourceScan {
  launches: DetectedLaunch[];
  invocations: DetectedAgentInvocation[];
  invocationWarnings: AgentInvocationDetectionWarning[];
  capabilities: DetectedCapability[];
  /** Confined metadata paths actually considered by the bounded extractor. */
  observedPaths: string[];
  /** False when an opaque path or work cap prevented a complete scan. */
  complete: boolean;
  /** Stable identity of the source content supplied to this extraction. */
  sourceFingerprint: `sha256:${string}`;
}

interface SupportedNamespaces {
  current: ReadonlySet<string>;
  legacy: ReadonlySet<string>;
}

function collectSupportedNamespaces(
  sourceFile: ts.SourceFile,
): SupportedNamespaces {
  const current = new Set<string>();
  const legacy = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@sapiom/tools"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      continue;
    }
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      const imported = specifier.propertyName?.text ?? specifier.name.text;
      if (imported === "agents") current.add(specifier.name.text);
      if (imported === "orchestrations") legacy.add(specifier.name.text);
    }
  }

  return { current, legacy };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function propertyAccessChain(expression: ts.Expression): string[] | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return [current.text];
  if (!ts.isPropertyAccessExpression(current) || current.questionDotToken) {
    return null;
  }
  const parent = propertyAccessChain(current.expression);
  return parent ? [...parent, current.name.text] : null;
}

function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) &&
      bindingContainsName(element.name, name),
  );
}

function declarationListContainsName(
  declarationList: ts.VariableDeclarationList,
  name: string,
): boolean {
  return declarationList.declarations.some((declaration) =>
    bindingContainsName(declaration.name, name),
  );
}

function statementDeclaresName(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return declarationListContainsName(statement.declarationList, name);
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text === name;
  }
  return false;
}

function functionBodyDeclaresVar(
  body: ts.ConciseBody | undefined,
  name: string,
): boolean {
  if (!body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== body && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclarationList(node) &&
      !(node.flags & ts.NodeFlags.BlockScoped) &&
      declarationListContainsName(node, name)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Import aliases are proven only while they still refer to that import. This
 * syntax-only scope check covers lexical declarations and parameters without
 * escalating to a Program or TypeChecker. */
function isImportedNamespaceShadowed(
  call: ts.CallExpression,
  name: string,
  sourceFile: ts.SourceFile,
): boolean {
  for (
    let ancestor = call.parent;
    ancestor && ancestor !== sourceFile;
    ancestor = ancestor.parent
  ) {
    if (ts.isFunctionLike(ancestor)) {
      if (
        ancestor.parameters.some((parameter) =>
          bindingContainsName(parameter.name, name),
        )
      ) {
        return true;
      }
      if (
        functionBodyDeclaresVar(
          (ancestor as ts.FunctionLikeDeclaration).body,
          name,
        )
      ) {
        return true;
      }
      if (
        (ts.isFunctionDeclaration(ancestor) ||
          ts.isFunctionExpression(ancestor)) &&
        ancestor.name?.text === name
      ) {
        return true;
      }
    }
    if (
      ts.isBlock(ancestor) &&
      ancestor.statements.some((statement) =>
        statementDeclaresName(statement, name),
      )
    ) {
      return true;
    }
    if (
      ts.isCatchClause(ancestor) &&
      ancestor.variableDeclaration &&
      bindingContainsName(ancestor.variableDeclaration.name, name)
    ) {
      return true;
    }
    if (
      (ts.isForStatement(ancestor) ||
        ts.isForInStatement(ancestor) ||
        ts.isForOfStatement(ancestor)) &&
      ancestor.initializer &&
      ts.isVariableDeclarationList(ancestor.initializer) &&
      declarationListContainsName(ancestor.initializer, name)
    ) {
      return true;
    }
  }
  return false;
}

function invocationMode(
  call: ts.CallExpression,
  namespaces: SupportedNamespaces,
  sourceFile: ts.SourceFile,
): AgentInvocationMode | null {
  const chain = propertyAccessChain(call.expression);
  if (!chain) return null;

  if (
    chain.length === 4 &&
    chain[0] === "ctx" &&
    chain[1] === "sapiom" &&
    chain[2] === "agents"
  ) {
    if (chain[3] === "run") return "blocking";
    if (chain[3] === "launch") return "async";
    return null;
  }

  if (chain.length !== 2) return null;
  const [namespace, method] = chain;
  if (
    namespaces.current.has(namespace!) &&
    !isImportedNamespaceShadowed(call, namespace!, sourceFile)
  ) {
    if (method === "run") return "blocking";
    if (method === "launch") return "async";
  }
  if (
    namespaces.legacy.has(namespace!) &&
    method === "launch" &&
    !isImportedNamespaceShadowed(call, namespace!, sourceFile)
  ) {
    return "async";
  }
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

type TargetResult = { kind: "literal"; slug: string } | { kind: "dynamic" };

/** Mirrors object-literal overwrite order sufficiently for a direct target:
 * an explicit `definition` after a spread wins; a later spread makes it
 * dynamic again because it could overwrite the target. */
function directDefinitionTarget(call: ts.CallExpression): TargetResult {
  const argument = call.arguments[0];
  if (!argument) return { kind: "dynamic" };
  const unwrapped = unwrapExpression(argument);
  if (!ts.isObjectLiteralExpression(unwrapped)) return { kind: "dynamic" };

  let result: TargetResult = { kind: "dynamic" };
  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    if (!property.name || propertyName(property.name) !== "definition") {
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    const value = unwrapExpression(property.initializer);
    result =
      ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
        ? { kind: "literal", slug: value.text }
        : { kind: "dynamic" };
  }
  return result;
}

function relativeEvidence(
  root: string,
  file: string,
  sourceFile: ts.SourceFile,
  position: number,
): SourceEvidence {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    file: path.relative(root, file).split(path.sep).join(path.posix.sep),
    line: location.line + 1,
    column: location.character + 1,
  };
}

function scanAgentInvocationsInFile(
  root: string,
  file: string,
  content: string,
  blocks: readonly StepBlock[],
): Pick<AgentInvocationScanResult, "invocations" | "warnings"> {
  const sourceFile = ts.createSourceFile(
    path.basename(file),
    content,
    ts.ScriptTarget.Latest,
    true,
    path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const namespaces = collectSupportedNamespaces(sourceFile);
  const invocations: DetectedAgentInvocation[] = [];
  const warnings: AgentInvocationDetectionWarning[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const mode = invocationMode(node, namespaces, sourceFile);
      if (mode) {
        const position = node.expression.getStart(sourceFile);
        const evidence = relativeEvidence(root, file, sourceFile, position);
        const target = directDefinitionTarget(node);
        if (target.kind === "literal") {
          invocations.push({
            slug: target.slug,
            mode,
            fromStepId: attributeTo(blocks, position),
            evidence,
          });
        } else {
          warnings.push({ code: "dynamic-target", mode, evidence });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { invocations, warnings };
}

function evidenceOrder(left: SourceEvidence, right: SourceEvidence): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column
  );
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
  readHooks: WorkflowSourceReadHooks = {},
): Promise<WorkflowSourceScan> {
  const invocations: DetectedAgentInvocation[] = [];
  const invocationWarnings: AgentInvocationDetectionWarning[] = [];
  const capabilities: DetectedCapability[] = [];
  const sourceSet = await listSourceFilesWithObservations(root);
  const fingerprintInputs: Array<{
    file: string;
    contentDigest: `sha256:${string}` | null;
  }> = [];
  let complete = sourceSet.complete;
  for (const file of sourceSet.files) {
    const content = await readWorkflowSourceFile(root, file, readHooks);
    fingerprintInputs.push({
      file: path.relative(root, file).split(path.sep).join(path.posix.sep),
      contentDigest:
        content === null
          ? null
          : `sha256:${createHash("sha256").update(content).digest("hex")}`,
    });
    if (content === null) {
      complete = false;
      continue;
    }

    const blocks = stepBlockRanges(content, knownStepIds);

    if (mayContainAgentInvocation(content)) {
      const invocationScan = scanAgentInvocationsInFile(
        root,
        file,
        content,
        blocks,
      );
      invocations.push(...invocationScan.invocations);
      invocationWarnings.push(...invocationScan.warnings);
    }
    for (const match of content.matchAll(CAPABILITY_CALL_PATTERN)) {
      const capability = match[1]!.replace(/\s+/g, "");
      if (NON_CAPABILITY_CALLS.has(capability)) continue;
      capabilities.push({
        capability,
        fromStepId: attributeTo(blocks, match.index),
      });
    }
  }
  invocations.sort((left, right) =>
    evidenceOrder(left.evidence, right.evidence),
  );
  invocationWarnings.sort((left, right) =>
    evidenceOrder(left.evidence, right.evidence),
  );
  const launches = invocations
    .filter((invocation) => invocation.mode === "async")
    .map(({ slug, fromStepId }) => ({ slug, fromStepId }));
  fingerprintInputs.sort((left, right) =>
    left.file === right.file ? 0 : left.file < right.file ? -1 : 1,
  );
  const sourceFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        protocol: 1,
        complete,
        sources: fingerprintInputs,
      }),
    )
    .digest("hex")}` as const;
  return {
    launches,
    invocations,
    invocationWarnings,
    capabilities,
    observedPaths: sourceSet.observedPaths,
    complete,
    sourceFingerprint,
  };
}

/** Direct agent invocations plus deterministic warnings for supported calls
 * whose target is not a direct literal. */
export async function detectAgentInvocations(
  root: string,
  knownStepIds: ReadonlySet<string>,
  readHooks: WorkflowSourceReadHooks = {},
): Promise<AgentInvocationScanResult> {
  const scan = await scanWorkflowSources(root, knownStepIds, readHooks);
  return {
    invocations: scan.invocations,
    warnings: scan.invocationWarnings,
    observedPaths: scan.observedPaths,
    complete: scan.complete,
  };
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
