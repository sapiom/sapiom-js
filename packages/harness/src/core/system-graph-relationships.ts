import { createHash } from "node:crypto";
import * as path from "node:path";
import ts from "typescript";

import {
  listSourceFilesWithObservations,
  readWorkflowSourceFile,
  type AgentInvocationDetectionWarning,
  type AgentInvocationMode,
  type SourceEvidence,
  type WorkflowSourceReadHooks,
} from "./canvas-interconnections.js";
import { fingerprintWorkflowSources } from "./canvas-cache.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";
import type { AgentInventoryItem } from "./system-graph-inventory.js";

export const INVOCATION_OBSERVATION_MAX_PATHS = 10_000;

export interface AgentInvocationCandidate {
  /** Inventory key or definition slug to resolve after extraction. */
  target: string;
  mode: AgentInvocationMode;
  /** Internal-only evidence retained across callsite deduplication. */
  evidence: SourceEvidence[];
}

export type AgentInvocationWarning = AgentInvocationDetectionWarning;

export interface AgentInvocationProviderResult {
  invocations: AgentInvocationCandidate[];
  warnings: AgentInvocationWarning[];
  /** Confined files considered by this bounded extraction generation. */
  observedPaths?: readonly string[];
  /** False when an opaque path or work cap prevented a complete scan. */
  complete?: boolean;
  /**
   * Stable content digest supplied by the authoritative source scan. A
   * successful provider result without a valid full SHA-256 digest is treated
   * as incomplete: the graph remains degraded and last-good evidence stays.
   * Synthetic pending/failed snapshots may omit it.
   */
  sourceFingerprint?: `sha256:${string}`;
}

export interface AgentInvocationSnapshot {
  status: "ready" | "failed";
  result: AgentInvocationProviderResult;
}

export interface AgentInvocationObservation {
  candidateRoot: string;
  workspaceRoot: string;
  paths: readonly string[];
}

/**
 * Replaceable per-caller boundary for literal direct invocations consumed by
 * the workspace graph projector. The caller is always the source endpoint.
 */
export interface AgentInvocationProvider {
  listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult>;
  /** Optional lifecycle hook for providers that retain per-caller state. */
  retainCallers?(callers: readonly AgentInventoryItem[]): void;
  /** Cache-only projection used by the first graph phase. */
  peekInvocations?(
    caller: AgentInventoryItem,
  ): AgentInvocationSnapshot | undefined;
  /** Starts bounded work only after the inventory-only graph is committed. */
  startInvocations?(callers: readonly AgentInventoryItem[]): void;
  /** Accepted/current invocation metadata consumed by polling watchers. */
  invocationObservations?(): readonly AgentInvocationObservation[];
}

interface CachedInvocationEntry {
  fingerprint: string;
  result: Promise<AgentInvocationProviderResult>;
}

interface InvocationTask {
  sourceRoot: string;
  caller: AgentInventoryItem;
  generation: number;
  scopeEpoch: number;
}

interface BackgroundInvocationEntry {
  generation: number;
  scopeEpoch: number;
  snapshot?: AgentInvocationSnapshot;
}

export interface CachedAgentInvocationProviderOptions {
  concurrency?: number;
  onChange?: (sourceRoots: readonly string[]) => void | Promise<void>;
  /** Small testable coalescing window; settled scopes never await global idle. */
  changeBatchMs?: number;
}

/**
 * Successful per-caller invocation extraction behind the same cheap source
 * fingerprint used by Canvas. Projection can therefore rebuild against a new
 * inventory without re-walking unchanged caller trees.
 */
export class CachedAgentInvocationProvider implements AgentInvocationProvider {
  private readonly entries = new Map<string, CachedInvocationEntry>();
  private readonly background = new Map<string, BackgroundInvocationEntry>();
  private readonly queued: InvocationTask[] = [];
  private readonly active = new Map<string, InvocationTask>();
  private readonly pendingChanges = new Set<string>();
  private readonly invalidatedScopes = new Map<string, number>();
  private nextGeneration = 1;
  private nextScopeEpoch = 1;
  private activeCount = 0;
  private observationsTruncated = false;
  private changeFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly inner: AgentInvocationProvider = new SourceAgentInvocationProvider(),
    private readonly fingerprint: (
      sourceRoot: string,
    ) => Promise<string> = fingerprintWorkflowSources,
    private readonly options: CachedAgentInvocationProviderOptions = {},
  ) {}

  async listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult> {
    const key = canonicalGraphPath(caller.sourceRoot);
    let fingerprint: string;
    try {
      fingerprint = await this.fingerprint(key);
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }

    const hit = this.entries.get(key);
    if (hit?.fingerprint === fingerprint) return hit.result;

    let result: Promise<AgentInvocationProviderResult>;
    try {
      result = Promise.resolve(this.inner.listInvocations(caller));
    } catch (error) {
      result = Promise.reject(error);
    }
    const entry = { fingerprint, result };
    this.entries.set(key, entry);
    void result.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return result;
  }

  invalidateSource(sourceRoot: string): void {
    const key = canonicalGraphPath(sourceRoot);
    this.entries.delete(key);
    this.background.set(key, {
      generation: this.nextGeneration++,
      scopeEpoch: this.scopeEpochForSource(key),
    });
    this.dropQueued(key);
    this.pendingChanges.delete(key);
  }

  /** O(1) conservative invalidation for an ambiguous workspace event. */
  invalidateScope(scopeRoot: string): void {
    this.invalidatedScopes.set(
      canonicalGraphPath(scopeRoot),
      this.nextScopeEpoch++,
    );
  }

  /** Explicit graph Retry re-arms terminal failures without read-loop churn. */
  retryFailed(scopeRoot: string): void {
    const root = canonicalGraphPath(scopeRoot);
    for (const [sourceRoot, entry] of this.background) {
      const relative = path.relative(root, sourceRoot);
      if (
        (entry.snapshot?.status !== "failed" &&
          !(
            entry.snapshot?.status === "ready" &&
            entry.snapshot.result.complete === false
          )) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        continue;
      }
      this.background.set(sourceRoot, {
        generation: this.nextGeneration++,
        scopeEpoch: this.scopeEpochForSource(sourceRoot),
      });
      this.dropQueued(sourceRoot);
    }
  }

  retainCallers(callers: readonly AgentInventoryItem[]): void {
    try {
      this.inner.retainCallers?.(callers);
    } catch {
      // Inner cache pruning is an optimization and cannot affect projection.
    }
    const retained = new Set(
      callers.map((caller) => canonicalGraphPath(caller.sourceRoot)),
    );
    for (const sourceRoot of this.entries.keys()) {
      if (!retained.has(sourceRoot)) this.entries.delete(sourceRoot);
    }
    for (const sourceRoot of this.background.keys()) {
      if (retained.has(sourceRoot)) continue;
      this.background.delete(sourceRoot);
      this.dropQueued(sourceRoot);
      this.pendingChanges.delete(sourceRoot);
    }
    for (const scopeRoot of this.invalidatedScopes.keys()) {
      if (
        [...retained].some((sourceRoot) =>
          this.scopeContainsSource(scopeRoot, sourceRoot),
        )
      ) {
        continue;
      }
      this.invalidatedScopes.delete(scopeRoot);
    }
    this.refreshObservationCoverage();
  }

  clear(): void {
    this.entries.clear();
    this.background.clear();
    this.queued.length = 0;
    this.pendingChanges.clear();
    if (this.changeFlushTimer) clearTimeout(this.changeFlushTimer);
    this.changeFlushTimer = null;
    this.invalidatedScopes.clear();
    this.nextGeneration += 1;
    this.nextScopeEpoch += 1;
    this.observationsTruncated = false;
  }

  peekInvocations(
    caller: AgentInventoryItem,
  ): AgentInvocationSnapshot | undefined {
    const sourceRoot = canonicalGraphPath(caller.sourceRoot);
    const entry = this.background.get(sourceRoot);
    if (entry?.scopeEpoch !== this.scopeEpochForSource(sourceRoot)) {
      return undefined;
    }
    if (
      this.observationsTruncated &&
      entry.snapshot?.status === "ready" &&
      entry.snapshot.result.complete !== false
    ) {
      return {
        status: "ready",
        result: { ...entry.snapshot.result, complete: false },
      };
    }
    return entry.snapshot;
  }

  startInvocations(callers: readonly AgentInventoryItem[]): void {
    for (const caller of callers) {
      const sourceRoot = canonicalGraphPath(caller.sourceRoot);
      let entry = this.background.get(sourceRoot);
      const scopeEpoch = this.scopeEpochForSource(sourceRoot);
      if (!entry || entry.scopeEpoch !== scopeEpoch) {
        entry = { generation: this.nextGeneration++, scopeEpoch };
        this.background.set(sourceRoot, entry);
        this.dropQueued(sourceRoot);
      }
      if (entry.snapshot) continue;
      if (
        this.active.get(sourceRoot)?.generation === entry.generation ||
        this.queued.some(
          (task) =>
            task.sourceRoot === sourceRoot &&
            task.generation === entry!.generation,
        )
      ) {
        continue;
      }
      this.dropQueued(sourceRoot);
      this.queued.push({
        sourceRoot,
        caller,
        generation: entry.generation,
        scopeEpoch: entry.scopeEpoch,
      });
    }
    this.drain();
  }

  invocationObservations(): readonly AgentInvocationObservation[] {
    const entries = [...this.background.entries()]
      .filter(
        ([sourceRoot, entry]) =>
          entry.scopeEpoch === this.scopeEpochForSource(sourceRoot) &&
          (entry.snapshot?.result.observedPaths?.length ?? 0) > 0,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const selected = new Map<string, string[]>();
    let remaining = INVOCATION_OBSERVATION_MAX_PATHS;
    let round = 0;
    while (remaining > 0) {
      let added = false;
      for (const [sourceRoot, entry] of entries) {
        if (remaining === 0) break;
        const observed = entry.snapshot?.result.observedPaths?.[round];
        if (!observed) continue;
        const paths = selected.get(sourceRoot) ?? [];
        paths.push(observed);
        selected.set(sourceRoot, paths);
        remaining -= 1;
        added = true;
      }
      if (!added) break;
      round += 1;
    }
    return [...selected.entries()].map(([sourceRoot, paths]) => ({
      candidateRoot: sourceRoot,
      workspaceRoot: sourceRoot,
      paths,
    }));
  }

  private current(task: InvocationTask): boolean {
    const entry = this.background.get(task.sourceRoot);
    return (
      entry?.generation === task.generation &&
      entry.scopeEpoch === task.scopeEpoch &&
      task.scopeEpoch === this.scopeEpochForSource(task.sourceRoot)
    );
  }

  private scopeContainsSource(scopeRoot: string, sourceRoot: string): boolean {
    const relative = path.relative(scopeRoot, sourceRoot);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  private scopeEpochForSource(sourceRoot: string): number {
    let epoch = 0;
    for (const [scopeRoot, candidateEpoch] of this.invalidatedScopes) {
      if (this.scopeContainsSource(scopeRoot, sourceRoot)) {
        epoch = Math.max(epoch, candidateEpoch);
      }
    }
    return epoch;
  }

  private refreshObservationCoverage(): void {
    let count = 0;
    let truncated = false;
    for (const [sourceRoot, entry] of this.background) {
      if (entry.scopeEpoch !== this.scopeEpochForSource(sourceRoot)) continue;
      count += entry.snapshot?.result.observedPaths?.length ?? 0;
      if (count > INVOCATION_OBSERVATION_MAX_PATHS) {
        truncated = true;
        break;
      }
    }
    if (truncated === this.observationsTruncated) return;
    this.observationsTruncated = truncated;
    // Coverage is part of every retained ready snapshot's effective
    // completeness. Crossing the global observation cap (in either direction)
    // therefore changes more than the task that happened to settle/retire.
    for (const [sourceRoot, entry] of this.background) {
      if (
        entry.snapshot &&
        entry.scopeEpoch === this.scopeEpochForSource(sourceRoot)
      ) {
        this.pendingChanges.add(sourceRoot);
      }
    }
    this.scheduleChanges();
  }

  private dropQueued(sourceRoot: string): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      if (this.queued[index]!.sourceRoot === sourceRoot) {
        this.queued.splice(index, 1);
      }
    }
  }

  private drain(): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      if (!this.current(this.queued[index]!)) this.queued.splice(index, 1);
    }
    const concurrency = Math.max(1, this.options.concurrency ?? 4);
    while (this.activeCount < concurrency) {
      const index = this.queued.findIndex(
        (task) => !this.active.has(task.sourceRoot),
      );
      if (index === -1) break;
      const [task] = this.queued.splice(index, 1);
      if (!task || !this.current(task)) continue;
      this.active.set(task.sourceRoot, task);
      this.activeCount += 1;
      void this.run(task).finally(() => {
        if (this.active.get(task.sourceRoot) === task) {
          this.active.delete(task.sourceRoot);
          this.activeCount -= 1;
        }
        this.drain();
      });
    }
  }

  private async run(task: InvocationTask): Promise<void> {
    let snapshot: AgentInvocationSnapshot;
    try {
      snapshot = {
        status: "ready",
        result: await this.inner.listInvocations(task.caller),
      };
    } catch {
      snapshot = {
        status: "failed",
        result: { invocations: [], warnings: [] },
      };
    }
    if (!this.current(task)) return;
    this.background.set(task.sourceRoot, {
      generation: task.generation,
      scopeEpoch: task.scopeEpoch,
      snapshot,
    });
    this.refreshObservationCoverage();
    this.pendingChanges.add(task.sourceRoot);
    this.scheduleChanges();
  }

  private scheduleChanges(): void {
    if (this.changeFlushTimer) return;
    this.changeFlushTimer = setTimeout(() => {
      this.changeFlushTimer = null;
      this.flushChanges();
    }, this.options.changeBatchMs ?? 0);
  }

  private flushChanges(): void {
    if (this.pendingChanges.size === 0) return;
    const changed = [...this.pendingChanges]
      .filter((sourceRoot) => {
        const entry = this.background.get(sourceRoot);
        return (
          entry?.snapshot !== undefined &&
          entry.scopeEpoch === this.scopeEpochForSource(sourceRoot)
        );
      })
      .sort();
    this.pendingChanges.clear();
    if (changed.length === 0) return;
    void Promise.resolve()
      .then(() => this.options.onChange?.(changed))
      .catch(() => {
        // Refresh hints cannot invalidate current invocation evidence.
      });
  }
}

function evidenceOrder(left: SourceEvidence, right: SourceEvidence): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column
  );
}

const MODE_ORDER: Record<AgentInvocationMode, number> = {
  blocking: 0,
  async: 1,
};

const PROGRAM_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

type TargetResult = { kind: "literal"; slug: string } | { kind: "dynamic" };
type WrapperTargetResult =
  | TargetResult
  | { kind: "parameter"; index: number };

interface PackageInvocation {
  target: string;
  mode: AgentInvocationMode;
  evidence: SourceEvidence;
}

interface PackageInvocationScan {
  invocations: PackageInvocation[];
  groupedInvocations: AgentInvocationCandidate[];
  warnings: AgentInvocationDetectionWarning[];
  observedPaths: string[];
  complete: boolean;
  sourceFingerprint: `sha256:${string}`;
}

function packageRootForCaller(caller: AgentInventoryItem): string {
  if (caller.path === ".") return canonicalGraphPath(caller.sourceRoot);
  const depth = caller.path.split("/").filter(Boolean).length;
  return canonicalGraphPath(
    path.resolve(caller.sourceRoot, ...Array.from({ length: depth }, () => "..")),
  );
}

function commonSourceRoot(callers: readonly AgentInventoryItem[]): string {
  const roots = callers
    .map(packageRootForCaller)
    .sort();
  const [first] = roots;
  if (!first) return process.cwd();
  const segments = first.split(path.sep);
  for (const root of roots.slice(1)) {
    const candidate = root.split(path.sep);
    let index = 0;
    while (index < segments.length && segments[index] === candidate[index]) {
      index += 1;
    }
    segments.length = index;
  }
  return segments.length === 0 ? path.parse(first).root : segments.join(path.sep);
}

function unwrapTsExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapTsExpression(expression.expression);
  }
  return expression;
}

function propertyAccessName(expression: ts.Expression): string | null {
  const current = unwrapTsExpression(expression);
  return ts.isIdentifier(current) ? current.text : null;
}

function objectPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function moduleSpecifierText(declaration: ts.Node): string | null {
  let statement: ts.Node | undefined = declaration;
  while (
    statement &&
    !ts.isImportDeclaration(statement) &&
    !ts.isExportDeclaration(statement) &&
    !ts.isSourceFile(statement)
  ) {
    statement = statement.parent;
  }
  if (
    statement &&
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return statement.moduleSpecifier.text;
  }
  if (
    statement &&
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return statement.moduleSpecifier.text;
  }
  return null;
}

function importedName(declaration: ts.Declaration): string | null {
  if (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration)) {
    return declaration.propertyName?.text ?? declaration.name.text;
  }
  return null;
}

function declarationName(declaration: ts.Declaration): string | null {
  const name = (declaration as { name?: ts.Node }).name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

function isSapiomToolsDeclaration(declaration: ts.Declaration): boolean {
  return declaration
    .getSourceFile()
    .fileName.split(path.sep)
    .join(path.posix.sep)
    .includes("/node_modules/@sapiom/tools/");
}

function aliasedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function resolvesSapiomNamespace(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  expected: "agents" | "orchestrations",
  seen = new Set<ts.Symbol>(),
): boolean {
  const current = unwrapTsExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    const namespace = objectPropertyName(current.name);
    if (namespace !== expected) return false;
    const owner = unwrapTsExpression(current.expression);
    if (!ts.isIdentifier(owner)) return false;
    const ownerSymbol = aliasedSymbol(checker, checker.getSymbolAtLocation(owner));
    return (
      ownerSymbol?.declarations?.some(
        (declaration) =>
          ts.isNamespaceImport(declaration) &&
          moduleSpecifierText(declaration) === "@sapiom/tools",
      ) ?? false
    );
  }
  if (!ts.isIdentifier(current)) return false;

  const rawSymbol = checker.getSymbolAtLocation(current);
  const candidates = [
    rawSymbol,
    rawSymbol ? aliasedSymbol(checker, rawSymbol) : undefined,
  ].filter((symbol): symbol is ts.Symbol => symbol !== undefined);
  for (const symbol of candidates) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        (ts.isImportSpecifier(declaration) ||
          ts.isExportSpecifier(declaration)) &&
        moduleSpecifierText(declaration) === "@sapiom/tools" &&
        importedName(declaration) === expected
      ) {
        return true;
      }
      if (
        isSapiomToolsDeclaration(declaration) &&
        declarationName(declaration) === expected
      ) {
        return true;
      }
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        resolvesSapiomNamespace(declaration.initializer, checker, expected, seen)
      ) {
        return true;
      }
    }
  }
  return false;
}

function packageInvocationMode(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): AgentInvocationMode | null {
  const expression = unwrapTsExpression(call.expression);
  if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken) {
    return null;
  }

  const method = expression.name.text;
  if (method !== "run" && method !== "launch") return null;
  const receiver = unwrapTsExpression(expression.expression);
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "agents") {
    const context = unwrapTsExpression(receiver.expression);
    if (
      ts.isPropertyAccessExpression(context) &&
      context.name.text === "sapiom" &&
      propertyAccessName(context.expression) === "ctx"
    ) {
      return method === "run" ? "blocking" : "async";
    }
  }
  if (resolvesSapiomNamespace(receiver, checker, "agents")) {
    return method === "run" ? "blocking" : "async";
  }
  if (method === "launch" && resolvesSapiomNamespace(receiver, checker, "orchestrations")) {
    return "async";
  }
  return null;
}

function symbolStringLiteral(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): string | null {
  const current = unwrapTsExpression(expression);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  if (!ts.isIdentifier(current)) return null;
  const symbol = aliasedSymbol(checker, checker.getSymbolAtLocation(current));
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ) {
          const resolved = symbolStringLiteral(
            checker,
            declaration.initializer,
            seen,
          );
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

function resolvedObjectLiteral(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ts.ObjectLiteralExpression | null {
  const current = unwrapTsExpression(expression);
  if (ts.isObjectLiteralExpression(current)) return current;
  if (!ts.isIdentifier(current)) return null;
  const symbol = aliasedSymbol(checker, checker.getSymbolAtLocation(current));
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ) {
      const resolved = resolvedObjectLiteral(
        checker,
        declaration.initializer,
        seen,
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

function staticDefinitionTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): TargetResult {
  const argument = call.arguments[0];
  if (!argument) return { kind: "dynamic" };
  const object = resolvedObjectLiteral(checker, argument);
  if (!object) return { kind: "dynamic" };

  let result: TargetResult = { kind: "dynamic" };
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    if (!property.name || objectPropertyName(property.name) !== "definition") {
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const resolved = symbolStringLiteral(checker, property.name);
      result =
        resolved === null
          ? { kind: "dynamic" }
          : { kind: "literal", slug: resolved };
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    const resolved = symbolStringLiteral(checker, property.initializer);
    result =
      resolved === null
        ? { kind: "dynamic" }
        : { kind: "literal", slug: resolved };
  }
  return result;
}

function parameterTarget(
  expression: ts.Expression,
  parameters: readonly ts.ParameterDeclaration[],
): WrapperTargetResult | null {
  const current = unwrapTsExpression(expression);
  if (!ts.isIdentifier(current)) return null;
  const index = parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === current.text,
  );
  return index === -1 ? null : { kind: "parameter", index };
}

function wrapperDefinitionTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  parameters: readonly ts.ParameterDeclaration[],
): WrapperTargetResult {
  const argument = call.arguments[0];
  if (!argument) return { kind: "dynamic" };
  const object = resolvedObjectLiteral(checker, argument);
  if (!object) return { kind: "dynamic" };

  let result: WrapperTargetResult = { kind: "dynamic" };
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    if (!property.name || objectPropertyName(property.name) !== "definition") {
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const parameter = parameterTarget(property.name, parameters);
      if (parameter) {
        result = parameter;
        continue;
      }
      const resolved = symbolStringLiteral(checker, property.name);
      result =
        resolved === null
          ? { kind: "dynamic" }
          : { kind: "literal", slug: resolved };
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    const parameter = parameterTarget(property.initializer, parameters);
    if (parameter) {
      result = parameter;
      continue;
    }
    const resolved = symbolStringLiteral(checker, property.initializer);
    result =
      resolved === null
        ? { kind: "dynamic" }
        : { kind: "literal", slug: resolved };
  }
  return result;
}

function relativeProgramEvidence(
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

function owningCaller(
  file: string,
  callers: readonly AgentInventoryItem[],
): AgentInventoryItem | null {
  const matches = callers.filter((caller) => {
    const relative = path.relative(caller.sourceRoot, file);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  });
  return (
    matches.sort(
      (left, right) => right.sourceRoot.length - left.sourceRoot.length,
    )[0] ?? null
  );
}

function stableScanFingerprint(
  files: readonly { file: string; content: string | null }[],
  complete: boolean,
): `sha256:${string}` {
  const sources = files
    .map(({ file, content }) => ({
      file,
      contentDigest:
        content === null
          ? null
          : `sha256:${createHash("sha256").update(content).digest("hex")}`,
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ protocol: 2, complete, sources }))
    .digest("hex")}`;
}

function createPackageProgram(rootNames: readonly string[]): ts.Program {
  return ts.createProgram([...rootNames], {
    allowJs: false,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
}

function symbolKey(symbol: ts.Symbol | undefined): string | null {
  const declarations = symbol?.declarations;
  if (!declarations || declarations.length === 0) return null;
  const declaration = declarations[0]!;
  const sourceFile = declaration.getSourceFile();
  return `${sourceFile.fileName}:${declaration.pos}:${declaration.end}`;
}

function directInvocationsInFunction(
  node: ts.Node,
  checker: ts.TypeChecker,
): Array<{ target: WrapperTargetResult; mode: AgentInvocationMode }> {
  const invocations: Array<{ target: WrapperTargetResult; mode: AgentInvocationMode }> = [];
  const body =
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)) &&
    node.body
      ? node.body
      : null;
  if (!body) return invocations;
  const parameters =
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node))
      ? node.parameters
      : [];
  const visit = (child: ts.Node): void => {
    if (child !== body && ts.isFunctionLike(child)) return;
    if (ts.isCallExpression(child)) {
      const mode = packageInvocationMode(child, checker);
      if (mode) {
        const target = wrapperDefinitionTarget(child, checker, parameters);
        invocations.push({ target, mode });
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(body);
  return invocations;
}

function functionLikeFromDeclaration(
  declaration: ts.Declaration,
): ts.Node | null {
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  return null;
}

function containingWrapperKey(
  node: ts.Node,
  checker: ts.TypeChecker,
  wrappers: ReadonlyMap<string, readonly { target: WrapperTargetResult; mode: AgentInvocationMode }[]>,
  sourceFile: ts.SourceFile,
): string | null {
  for (let ancestor = node.parent; ancestor && ancestor !== sourceFile; ancestor = ancestor.parent) {
    if (
      ts.isFunctionDeclaration(ancestor) ||
      ts.isFunctionExpression(ancestor) ||
      ts.isArrowFunction(ancestor)
    ) {
      const declaration = ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)
        ? ancestor.parent
        : ancestor;
      const symbol =
        ts.isFunctionDeclaration(declaration) && declaration.name
          ? checker.getSymbolAtLocation(declaration.name)
          : ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
            ? checker.getSymbolAtLocation(declaration.name)
            : undefined;
      const key = symbolKey(aliasedSymbol(checker, symbol));
      if (key && wrappers.has(key)) return key;
    }
  }
  return null;
}

function resolveWrapperInvocationTarget(
  target: WrapperTargetResult,
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): string | null {
  if (target.kind === "literal") return target.slug;
  if (target.kind !== "parameter") return null;
  const argument = call.arguments[target.index];
  return argument ? symbolStringLiteral(checker, argument) : null;
}

async function scanPackageInvocations(
  callers: readonly AgentInventoryItem[],
  readHooks: WorkflowSourceReadHooks,
): Promise<Map<string, AgentInvocationProviderResult>> {
  const orderedCallers = [...callers].sort((left, right) =>
    left.agentKey.localeCompare(right.agentKey),
  );
  const byAgentKey = new Map<string, PackageInvocationScan>();
  const rootNames: string[] = [];
  const observed = new Set<string>();
  let complete = true;
  for (const caller of orderedCallers) {
    const sourceSet = await listSourceFilesWithObservations(caller.sourceRoot);
    if (!sourceSet.complete) complete = false;
    sourceSet.files.forEach((file) => rootNames.push(file));
    sourceSet.observedPaths.forEach((path) => observed.add(path));
    byAgentKey.set(caller.agentKey, {
      invocations: [],
      groupedInvocations: [],
      warnings: [],
      observedPaths: [...sourceSet.observedPaths],
      complete: sourceSet.complete,
      sourceFingerprint: `sha256:${"0".repeat(64)}`,
    });
  }
  const program = createPackageProgram([...new Set(rootNames)].sort());
  const checker = program.getTypeChecker();
  const workspaceRoot = commonSourceRoot(orderedCallers);
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile &&
        PROGRAM_SOURCE_EXTENSIONS.has(path.extname(sourceFile.fileName)) &&
        !sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`) &&
        path.relative(workspaceRoot, sourceFile.fileName) !== ".." &&
        !path
          .relative(workspaceRoot, sourceFile.fileName)
          .startsWith(`..${path.sep}`),
    )
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  const contents = new Map<string, string | null>();
  for (const sourceFile of sourceFiles) {
    observed.add(sourceFile.fileName);
    const owner = owningCaller(sourceFile.fileName, orderedCallers);
    const content = owner
      ? await readWorkflowSourceFile(
          owner.sourceRoot,
          sourceFile.fileName,
          readHooks,
        )
      : sourceFile.text;
    if (content === null) complete = false;
    contents.set(sourceFile.fileName, content);
  }

  const wrappers = new Map<
    string,
    Array<{ target: WrapperTargetResult; mode: AgentInvocationMode }>
  >();
  for (const sourceFile of sourceFiles) {
    if (contents.get(sourceFile.fileName) === null) continue;
    const visit = (node: ts.Node): void => {
      const callable = functionLikeFromDeclaration(node as ts.Declaration);
      if (callable) {
        const symbol =
          ts.isFunctionDeclaration(node) && node.name
            ? checker.getSymbolAtLocation(node.name)
            : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
              ? checker.getSymbolAtLocation(node.name)
              : undefined;
        const key = symbolKey(aliasedSymbol(checker, symbol));
        const invocations = directInvocationsInFunction(callable, checker);
        if (key && invocations.length > 0) wrappers.set(key, invocations);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const sourceFile of sourceFiles) {
    if (contents.get(sourceFile.fileName) === null) continue;
    const caller = owningCaller(sourceFile.fileName, orderedCallers);
    if (!caller) continue;
    const scan = byAgentKey.get(caller.agentKey)!;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const mode = packageInvocationMode(node, checker);
        const position = node.expression.getStart(sourceFile);
        if (mode) {
          if (containingWrapperKey(node, checker, wrappers, sourceFile)) {
            ts.forEachChild(node, visit);
            return;
          }
          const evidence = relativeProgramEvidence(
            caller.sourceRoot,
            sourceFile.fileName,
            sourceFile,
            position,
          );
          const target = staticDefinitionTarget(node, checker);
          if (target.kind === "literal") {
            scan.invocations.push({ target: target.slug, mode, evidence });
          } else {
            scan.warnings.push({ code: "dynamic-target", mode, evidence });
          }
        } else {
          const expression = unwrapTsExpression(node.expression);
          const symbol =
            ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
              ? aliasedSymbol(checker, checker.getSymbolAtLocation(expression))
              : undefined;
          const wrapper = wrappers.get(symbolKey(symbol) ?? "");
          if (wrapper) {
            const evidence = relativeProgramEvidence(
              caller.sourceRoot,
              sourceFile.fileName,
              sourceFile,
              position,
            );
            for (const invocation of wrapper) {
              const target = resolveWrapperInvocationTarget(
                invocation.target,
                node,
                checker,
              );
              if (target === null) {
                scan.warnings.push({
                  code: "dynamic-target",
                  mode: invocation.mode,
                  evidence,
                });
              } else {
                scan.invocations.push({
                  target,
                  mode: invocation.mode,
                  evidence,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const fingerprint = stableScanFingerprint(
    sourceFiles.map((sourceFile) => ({
      file: path.relative(workspaceRoot, sourceFile.fileName).split(path.sep).join(path.posix.sep),
      content: contents.get(sourceFile.fileName) ?? sourceFile.text,
    })),
    complete,
  );
  for (const scan of byAgentKey.values()) {
    scan.observedPaths = [
      ...new Set([...scan.observedPaths, ...observed]),
    ].sort();
    scan.complete = scan.complete && complete;
    scan.sourceFingerprint = fingerprint;
    const grouped = new Map<string, AgentInvocationCandidate>();
    for (const invocation of scan.invocations.sort((left, right) =>
      evidenceOrder(left.evidence, right.evidence),
    )) {
      const key = `${invocation.target}\0${invocation.mode}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.evidence.push(invocation.evidence);
      } else {
        grouped.set(key, {
          target: invocation.target,
          mode: invocation.mode,
          evidence: [invocation.evidence],
        });
      }
    }
    scan.groupedInvocations = [...grouped.values()];
    for (const candidate of scan.groupedInvocations) {
      candidate.evidence.sort(evidenceOrder);
    }
    scan.groupedInvocations.sort(
      (left, right) =>
        left.evidence[0]!.file.localeCompare(right.evidence[0]!.file) ||
        left.evidence[0]!.line - right.evidence[0]!.line ||
        left.evidence[0]!.column - right.evidence[0]!.column ||
        MODE_ORDER[left.mode] - MODE_ORDER[right.mode] ||
        left.target.localeCompare(right.target),
    );
    scan.warnings.sort((left, right) =>
      evidenceOrder(left.evidence, right.evidence),
    );
  }
  return new Map(
    [...byAgentKey].map(([agentKey, scan]) => [
      agentKey,
      {
        invocations: scan.groupedInvocations,
        warnings: scan.warnings,
        observedPaths: scan.observedPaths,
        complete: scan.complete,
        sourceFingerprint: scan.sourceFingerprint,
      },
    ]),
  );
}
/**
 * V0 per-agent filesystem adapter for literal direct invocations.
 *
 * It builds one package-wide TypeScript Program for the retained caller set so
 * imports, re-exports, and simple static wrappers are resolved consistently.
 * Inventory target resolution, input-provenance analysis, runtime dispatch,
 * renderer, transport, deployment, and session dependencies stay outside this
 * provider.
 */
export class SourceAgentInvocationProvider implements AgentInvocationProvider {
  private retainedCallers: readonly AgentInventoryItem[] = [];
  private inFlight:
    | {
        key: string;
        result: Promise<Map<string, AgentInvocationProviderResult>>;
      }
    | null = null;

  constructor(private readonly readHooks: WorkflowSourceReadHooks = {}) {}

  retainCallers(callers: readonly AgentInventoryItem[]): void {
    this.retainedCallers = [...callers].sort((left, right) =>
      left.agentKey.localeCompare(right.agentKey),
    );
  }

  async listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult> {
    const callers = this.retainedCallers.some(
      (candidate) => candidate.agentKey === caller.agentKey,
    )
      ? this.retainedCallers
      : [caller];
    const key = callers
      .map((candidate) => `${candidate.agentKey}\0${candidate.sourceRoot}`)
      .sort()
      .join("\0");
    if (!this.inFlight || this.inFlight.key !== key) {
      const result = scanPackageInvocations(callers, this.readHooks).finally(() => {
        if (this.inFlight?.key === key) this.inFlight = null;
      });
      this.inFlight = { key, result };
    }
    const packageResult = await this.inFlight.result;
    return (
      packageResult.get(caller.agentKey) ?? {
        invocations: [],
        warnings: [],
        observedPaths: [],
        complete: false,
      }
    );
  }
}
