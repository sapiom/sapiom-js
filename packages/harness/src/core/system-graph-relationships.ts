import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

import {
  listSourceFilesWithObservations,
  readWorkflowSourceFile,
  workflowSourceFileMetadata,
  type AgentInvocationDetectionWarning,
  type AgentInvocationMode,
  type SourceEvidence,
  type WorkflowSourceReadHooks,
} from "./canvas-interconnections.js";
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
  cacheKey: string;
  sourceRoot: string;
  caller: AgentInventoryItem;
  generation: number;
  scopeEpoch: number;
}

interface BackgroundInvocationEntry {
  generation: number;
  scopeEpoch: number;
  caller?: AgentInventoryItem;
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
  private retainedCallers: readonly AgentInventoryItem[] = [];
  private nextGeneration = 1;
  private nextScopeEpoch = 1;
  private activeCount = 0;
  private observationsTruncated = false;
  private changeFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly inner: AgentInvocationProvider = new SourceAgentInvocationProvider(),
    private readonly fingerprint: (
      sourceRoot: string,
    ) => Promise<string> = fingerprintSystemGraphPackageSources,
    private readonly options: CachedAgentInvocationProviderOptions = {},
  ) {}

  async listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult> {
    const key = callerInvocationCacheKey(caller);
    let fingerprint: string;
    try {
      fingerprint = await this.fingerprint(packageRootForCaller(caller));
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
    const changed = canonicalGraphPath(sourceRoot);
    const candidateCallers = new Map<string, AgentInventoryItem>();
    for (const caller of this.retainedCallers) {
      candidateCallers.set(callerInvocationCacheKey(caller), caller);
    }
    for (const [key, entry] of this.background) {
      if (entry.caller) candidateCallers.set(key, entry.caller);
    }
    const affected = [...candidateCallers.values()].filter((caller) => {
      const callerRoot = canonicalGraphPath(caller.sourceRoot);
      const packageRoot = packageRootForCaller(caller);
      return (
        callerRoot === changed ||
        packageRoot === changed ||
        this.scopeContainsSource(packageRoot, changed) ||
        this.scopeContainsSource(changed, callerRoot)
      );
    });
    if (affected.length === 0) {
      this.entries.delete(changed);
      this.background.set(changed, {
        generation: this.nextGeneration++,
        scopeEpoch: this.scopeEpochForSource(changed),
      });
      this.dropQueued(changed);
      this.pendingChanges.delete(changed);
      return;
    }
    for (const caller of affected) {
      const key = callerInvocationCacheKey(caller);
      this.entries.delete(key);
      this.background.set(key, {
        generation: this.nextGeneration++,
        scopeEpoch: this.scopeEpochForSource(caller.sourceRoot),
        caller,
      });
      this.dropQueued(key);
      this.pendingChanges.delete(caller.sourceRoot);
    }
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
    for (const [cacheKey, entry] of this.background) {
      const sourceRoot = canonicalGraphPath(entry.caller?.sourceRoot ?? cacheKey);
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
      this.background.set(cacheKey, {
        generation: this.nextGeneration++,
        scopeEpoch: this.scopeEpochForSource(sourceRoot),
        ...(entry.caller ? { caller: entry.caller } : {}),
      });
      this.dropQueued(cacheKey);
    }
  }

  retainCallers(callers: readonly AgentInventoryItem[]): void {
    this.retainedCallers = [...callers].sort(
      (left, right) =>
        callerInvocationCacheKey(left).localeCompare(callerInvocationCacheKey(right)),
    );
    try {
      this.inner.retainCallers?.(this.retainedCallers);
    } catch {
      // Inner cache pruning is an optimization and cannot affect projection.
    }
    const retained = new Set(
      this.retainedCallers.map(callerInvocationCacheKey),
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
        this.retainedCallers.some((caller) =>
          this.scopeContainsSource(scopeRoot, caller.sourceRoot),
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
    const key = callerInvocationCacheKey(caller);
    const entry = this.background.get(key);
    if (entry?.scopeEpoch !== this.scopeEpochForSource(caller.sourceRoot)) {
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
      const key = callerInvocationCacheKey(caller);
      const sourceRoot = canonicalGraphPath(caller.sourceRoot);
      let entry = this.background.get(key);
      const scopeEpoch = this.scopeEpochForSource(sourceRoot);
      if (!entry || entry.scopeEpoch !== scopeEpoch) {
        entry = { generation: this.nextGeneration++, scopeEpoch, caller };
        this.background.set(key, entry);
        this.dropQueued(key);
      }
      if (entry.snapshot) continue;
      if (
        this.active.get(key)?.generation === entry.generation ||
        this.queued.some(
          (task) =>
            task.cacheKey === key &&
            task.generation === entry!.generation,
        )
      ) {
        continue;
      }
      this.dropQueued(key);
      this.queued.push({
        cacheKey: key,
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
        ([, entry]) =>
          entry.caller &&
          entry.scopeEpoch === this.scopeEpochForSource(entry.caller.sourceRoot) &&
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
    return [...selected.entries()].flatMap(([key, paths]) => {
      const caller = this.background.get(key)?.caller;
      if (!caller) return [];
      const packageRoot = packageRootForCaller(caller);
      return [{ candidateRoot: packageRoot, workspaceRoot: packageRoot, paths }];
    });
  }

  private current(task: InvocationTask): boolean {
    const entry = this.background.get(task.cacheKey);
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
    for (const [, entry] of this.background) {
      const sourceRoot = entry.caller?.sourceRoot;
      if (!sourceRoot) continue;
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
    for (const [, entry] of this.background) {
      const sourceRoot = entry.caller?.sourceRoot;
      if (
        sourceRoot &&
        entry.snapshot &&
        entry.scopeEpoch === this.scopeEpochForSource(sourceRoot)
      ) {
        this.pendingChanges.add(sourceRoot);
      }
    }
    this.scheduleChanges();
  }

  private dropQueued(cacheKey: string): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      if (this.queued[index]!.cacheKey === cacheKey) {
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
        (task) => !this.active.has(task.cacheKey),
      );
      if (index === -1) break;
      const [task] = this.queued.splice(index, 1);
      if (!task || !this.current(task)) continue;
      this.active.set(task.cacheKey, task);
      this.activeCount += 1;
      void this.run(task).finally(() => {
        if (this.active.get(task.cacheKey) === task) {
          this.active.delete(task.cacheKey);
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
    this.background.set(task.cacheKey, {
      generation: task.generation,
      scopeEpoch: task.scopeEpoch,
      caller: task.caller,
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
        const entry = [...this.background.values()].find(
          (candidate) => candidate.caller?.sourceRoot === sourceRoot,
        );
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
export type SystemGraphInvocationMethodResolution =
  | { kind: "resolved"; mode: AgentInvocationMode }
  | { kind: "dynamic"; modes: readonly AgentInvocationMode[] };

export type SystemGraphInvocationTargetResolution =
  | { kind: "resolved"; mode: AgentInvocationMode; target: string }
  | { kind: "dynamic-target"; mode: AgentInvocationMode }
  | { kind: "dynamic-method"; modes: readonly AgentInvocationMode[] };

export interface SystemGraphPackageSource {
  path: string;
  source: string;
  sourceFile: ts.SourceFile;
}

export interface SystemGraphPackageCompilerResult {
  packageKey: string;
  packageRoot: string;
  generation: number;
  program: ts.Program;
  checker: ts.TypeChecker;
  sources: ReadonlyMap<string, SystemGraphPackageSource>;
  observedPaths: readonly string[];
  complete: boolean;
  sourceFingerprint: `sha256:${string}`;
  resolveInvocationTarget(
    call: ts.CallExpression,
  ): SystemGraphInvocationTargetResolution | null;
}

export interface SystemGraphPackageCompilerInput {
  packageRoot: string;
  generation?: number;
  readHooks?: WorkflowSourceReadHooks;
}

type InvocationMethodAliasMap = ReadonlyMap<
  string,
  SystemGraphInvocationMethodResolution
>;
type InvocationMethodWrite =
  | { kind: "method"; resolution: SystemGraphInvocationMethodResolution }
  | { kind: "alias"; key: string }
  | { kind: "non-method" };

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

interface PackageSourceSnapshot {
  packageRoot: string;
  files: ReadonlyMap<string, string>;
  observedPaths: readonly string[];
  complete: boolean;
}

function packageRootForCaller(caller: AgentInventoryItem): string {
  if (caller.path === ".") return canonicalGraphPath(caller.sourceRoot);
  const depth = caller.path.split("/").filter(Boolean).length;
  return canonicalGraphPath(
    path.resolve(
      caller.sourceRoot,
      ...Array.from({ length: depth }, () => ".."),
    ),
  );
}

function callerInvocationCacheKey(caller: AgentInventoryItem): string {
  return [
    packageRootForCaller(caller),
    caller.agentKey,
    canonicalGraphPath(caller.sourceRoot),
  ].join("\0");
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

function expressionPropertyName(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): string | null {
  const current = unwrapTsExpression(expression);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  return symbolStringLiteral(checker, current);
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

function expressionValueSymbol(
  checker: ts.TypeChecker,
  expression: ts.Identifier | ts.PropertyAccessExpression,
): ts.Symbol | undefined {
  if (
    ts.isIdentifier(expression) &&
    ts.isShorthandPropertyAssignment(expression.parent) &&
    expression.parent.name === expression
  ) {
    return checker.getShorthandAssignmentValueSymbol(expression.parent);
  }
  return checker.getSymbolAtLocation(expression);
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

function directInvocationMethodResolution(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): SystemGraphInvocationMethodResolution | null {
  const current = unwrapTsExpression(expression);
  let receiver: ts.Expression;
  let method: string | null;
  let dynamicMethod = false;

  if (ts.isPropertyAccessExpression(current)) {
    if (current.questionDotToken) return null;
    receiver = unwrapTsExpression(current.expression);
    method = current.name.text;
  } else if (ts.isElementAccessExpression(current)) {
    if (current.questionDotToken) return null;
    receiver = unwrapTsExpression(current.expression);
    method = expressionPropertyName(checker, current.argumentExpression);
    dynamicMethod = method === null;
  } else {
    return null;
  }

  if (method !== null && method !== "run" && method !== "launch") return null;
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "agents") {
    const context = unwrapTsExpression(receiver.expression);
    if (
      ts.isPropertyAccessExpression(context) &&
      context.name.text === "sapiom" &&
      propertyAccessName(context.expression) === "ctx"
    ) {
      return dynamicMethod
        ? { kind: "dynamic", modes: ["blocking", "async"] }
        : { kind: "resolved", mode: method === "run" ? "blocking" : "async" };
    }
  }
  if (resolvesSapiomNamespace(receiver, checker, "agents")) {
    return dynamicMethod
      ? { kind: "dynamic", modes: ["blocking", "async"] }
      : { kind: "resolved", mode: method === "run" ? "blocking" : "async" };
  }
  if (resolvesSapiomNamespace(receiver, checker, "orchestrations")) {
    if (dynamicMethod) return { kind: "dynamic", modes: ["async"] };
    if (method === "launch") return { kind: "resolved", mode: "async" };
  }
  return null;
}

function packageInvocationMethodResolution(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  methodAliases: InvocationMethodAliasMap = new Map(),
): SystemGraphInvocationMethodResolution | null {
  const direct = directInvocationMethodResolution(call.expression, checker);
  if (direct) return direct;
  const expression = unwrapTsExpression(call.expression);
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) {
    return null;
  }
  const symbol = aliasedSymbol(checker, checker.getSymbolAtLocation(expression));
  const key = symbolKey(symbol);
  return key ? methodAliases.get(key) ?? null : null;
}

function packageInvocationMode(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  methodAliases: InvocationMethodAliasMap = new Map(),
): AgentInvocationMode | null {
  const resolution = packageInvocationMethodResolution(call, checker, methodAliases);
  return resolution?.kind === "resolved" ? resolution.mode : null;
}

function resolvePackageInvocationTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  methodAliases: InvocationMethodAliasMap,
): SystemGraphInvocationTargetResolution | null {
  const method = packageInvocationMethodResolution(call, checker, methodAliases);
  if (!method) return null;
  if (method.kind === "dynamic") {
    return { kind: "dynamic-method", modes: [...method.modes].sort((left, right) => MODE_ORDER[left] - MODE_ORDER[right]) };
  }
  const target = staticDefinitionTarget(call, checker);
  return target.kind === "literal"
    ? { kind: "resolved", mode: method.mode, target: target.slug }
    : { kind: "dynamic-target", mode: method.mode };
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
  const symbol = aliasedSymbol(checker, expressionValueSymbol(checker, current));
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
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

function invocationMethodFromName(
  namespace: "agents" | "orchestrations",
  method: string,
): SystemGraphInvocationMethodResolution | null {
  if (namespace === "agents") {
    if (method === "run") return { kind: "resolved", mode: "blocking" };
    if (method === "launch") return { kind: "resolved", mode: "async" };
  }
  if (namespace === "orchestrations" && method === "launch") {
    return { kind: "resolved", mode: "async" };
  }
  return null;
}

function symbolWriteKey(
  checker: ts.TypeChecker,
  name: ts.Node,
): string | null {
  if (!ts.isIdentifier(name) && !ts.isPropertyAccessExpression(name)) {
    return null;
  }
  return symbolKey(aliasedSymbol(checker, checker.getSymbolAtLocation(name)));
}

function methodWriteFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): InvocationMethodWrite {
  const direct = directInvocationMethodResolution(expression, checker);
  if (direct) return { kind: "method", resolution: direct };
  const current = unwrapTsExpression(expression);
  if (ts.isConditionalExpression(current)) {
    const whenTrue = methodWriteFromExpression(
      current.whenTrue,
      checker,
    );
    const whenFalse = methodWriteFromExpression(
      current.whenFalse,
      checker,
    );
    return whenTrue.kind !== "non-method" || whenFalse.kind !== "non-method"
      ? { kind: "method", resolution: { kind: "dynamic", modes: ["blocking", "async"] } }
      : { kind: "non-method" };
  }
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
    return { kind: "non-method" };
  }
  const key = symbolWriteKey(checker, current);
  return key ? { kind: "alias", key } : { kind: "non-method" };
}

function addMethodAliasWrite(
  writes: Map<string, InvocationMethodWrite[]>,
  checker: ts.TypeChecker,
  name: ts.Node,
  write: InvocationMethodWrite,
): void {
  const key = symbolWriteKey(checker, name);
  if (!key) return;
  const existing = writes.get(key) ?? [];
  existing.push(write);
  writes.set(key, existing);
}

function collectDestructuredMethodAliases(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  writes: Map<string, InvocationMethodWrite[]>,
): void {
  if (!declaration.initializer || !ts.isObjectBindingPattern(declaration.name)) {
    return;
  }
  const initializer = unwrapTsExpression(declaration.initializer);
  const namespace = resolvesSapiomNamespace(initializer, checker, "agents")
    ? "agents"
    : resolvesSapiomNamespace(initializer, checker, "orchestrations")
      ? "orchestrations"
      : null;
  if (!namespace) return;
  for (const element of declaration.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
    const method = element.propertyName
      ? objectPropertyName(element.propertyName)
      : element.name.text;
    if (!method) continue;
    const resolution = invocationMethodFromName(namespace, method);
    if (!resolution) continue;
    addMethodAliasWrite(
      writes,
      checker,
      element.name,
      { kind: "method", resolution },
    );
  }
}

function collectInvocationMethodAliases(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): InvocationMethodAliasMap {
  const writes = new Map<string, InvocationMethodWrite[]>();
  const methodAliases = new Map<string, SystemGraphInvocationMethodResolution>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      collectDestructuredMethodAliases(node, checker, writes);
      if (node.initializer) {
        addMethodAliasWrite(
          writes,
          checker,
          node.name,
          methodWriteFromExpression(node.initializer, checker),
        );
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrapTsExpression(node.left);
      if (ts.isIdentifier(left) || ts.isPropertyAccessExpression(left)) {
        addMethodAliasWrite(
          writes,
          checker,
          left,
          methodWriteFromExpression(node.right, checker),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of sourceFiles) visit(sourceFile);

  const resolveWrites = (
    key: string,
    seen = new Set<string>(),
  ): {
    resolutions: SystemGraphInvocationMethodResolution[];
    nonMethod: boolean;
    unresolved: boolean;
  } => {
    const symbolWrites = writes.get(key);
    if (!symbolWrites || symbolWrites.length === 0) {
      return { resolutions: [], nonMethod: false, unresolved: true };
    }
    if (seen.has(key)) {
      return { resolutions: [], nonMethod: false, unresolved: true };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const resolutions: SystemGraphInvocationMethodResolution[] = [];
    let nonMethod = false;
    let unresolved = false;
    for (const write of symbolWrites) {
      if (write.kind === "method") {
        resolutions.push(write.resolution);
      } else if (write.kind === "non-method") {
        nonMethod = true;
      } else {
        const resolved = resolveWrites(write.key, nextSeen);
        resolutions.push(...resolved.resolutions);
        nonMethod ||= resolved.nonMethod;
        unresolved ||= resolved.unresolved;
      }
    }
    return { resolutions, nonMethod, unresolved };
  };

  for (const [key, symbolWrites] of writes) {
    const resolved = resolveWrites(key);
    if (resolved.resolutions.length === 0) continue;
    methodAliases.set(
      key,
      symbolWrites.length === 1 &&
        resolved.resolutions.length === 1 &&
        !resolved.nonMethod &&
        !resolved.unresolved &&
        resolved.resolutions[0]!.kind === "resolved"
        ? resolved.resolutions[0]!
        : { kind: "dynamic", modes: ["blocking", "async"] },
    );
  }
  return methodAliases;
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
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
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
  checker: ts.TypeChecker,
): WrapperTargetResult | null {
  const current = unwrapTsExpression(expression);
  if (!ts.isIdentifier(current)) return null;
  const expressionKey = symbolKey(
    aliasedSymbol(checker, expressionValueSymbol(checker, current)),
  );
  if (!expressionKey) return null;
  const index = parameters.findIndex((parameter) => {
    if (!ts.isIdentifier(parameter.name)) return false;
    const parameterKey = symbolKey(
      aliasedSymbol(checker, checker.getSymbolAtLocation(parameter.name)),
    );
    return parameterKey === expressionKey;
  });
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
      const parameter = parameterTarget(property.name, parameters, checker);
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
    const parameter = parameterTarget(property.initializer, parameters, checker);
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

function lexicalAbsolutePath(fileName: string, base: string): string {
  return path.normalize(
    path.isAbsolute(fileName) ? fileName : path.resolve(base, fileName),
  );
}

function containedLexicalPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function snapshotMemberPath(
  snapshot: PackageSourceSnapshot,
  fileName: string,
): string | null {
  const candidate = lexicalAbsolutePath(fileName, snapshot.packageRoot);
  return containedLexicalPath(snapshot.packageRoot, candidate) &&
    snapshot.files.has(candidate)
    ? candidate
    : null;
}

async function snapshotPackageSources(
  packageRoot: string,
  readHooks: WorkflowSourceReadHooks,
): Promise<PackageSourceSnapshot> {
  const canonicalPackageRoot = canonicalGraphPath(packageRoot);
  const sourceSet = await listSourceFilesWithObservations(canonicalPackageRoot);
  const files = new Map<string, string>();
  const observedPaths = new Set(sourceSet.observedPaths.map(canonicalGraphPath));
  let complete = sourceSet.complete;
  for (const file of sourceSet.files) {
    const canonicalFile = canonicalGraphPath(file);
    const content = await readWorkflowSourceFile(
      canonicalPackageRoot,
      canonicalFile,
      readHooks,
    );
    if (content === null) {
      complete = false;
      continue;
    }
    files.set(canonicalFile, content);
  }
  const toolsDeclaration = lexicalAbsolutePath(
    path.join(
      canonicalPackageRoot,
      "node_modules",
      "@sapiom",
      "tools",
      "index.d.ts",
    ),
    canonicalPackageRoot,
  );
  let toolsDeclarationExists = true;
  try {
    await fs.lstat(toolsDeclaration);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      toolsDeclarationExists = false;
    } else {
      complete = false;
      observedPaths.add(toolsDeclaration);
    }
  }
  if (toolsDeclarationExists) {
    const toolsDeclarationMetadata = await workflowSourceFileMetadata(
      canonicalPackageRoot,
      toolsDeclaration,
    );
    if (toolsDeclarationMetadata.status === "regular") {
      const toolsDeclarationSource = await readWorkflowSourceFile(
        canonicalPackageRoot,
        toolsDeclaration,
        readHooks,
      );
      if (toolsDeclarationSource === null) {
        complete = false;
      } else {
        files.set(toolsDeclaration, toolsDeclarationSource);
        observedPaths.add(toolsDeclaration);
      }
    } else {
      complete = false;
      observedPaths.add(toolsDeclaration);
    }
  }
  return {
    packageRoot: canonicalPackageRoot,
    files,
    observedPaths: [...observedPaths].sort(),
    complete,
  };
}

function createPackageProgram(snapshot: PackageSourceSnapshot): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    allowJs: false,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  const sourceFiles = snapshot.files;
  const hasFile = (fileName: string): boolean =>
    snapshotMemberPath(snapshot, fileName) !== null;
  return ts.createProgram([...sourceFiles.keys()].sort(), compilerOptions, {
    ...host,
    getCurrentDirectory: () => snapshot.packageRoot,
    getCanonicalFileName: (fileName) =>
      lexicalAbsolutePath(fileName, snapshot.packageRoot),
    fileExists: hasFile,
    readFile: (fileName) => {
      const member = snapshotMemberPath(snapshot, fileName);
      return member ? sourceFiles.get(member) : undefined;
    },
    realpath: (fileName) => lexicalAbsolutePath(fileName, snapshot.packageRoot),
    directoryExists: (directoryName) => {
      const canonicalDirectory = lexicalAbsolutePath(
        directoryName,
        snapshot.packageRoot,
      );
      if (!containedLexicalPath(snapshot.packageRoot, canonicalDirectory)) {
        return false;
      }
      return [...sourceFiles.keys()].some((fileName) => {
        const relative = path.relative(canonicalDirectory, fileName);
        return (
          relative !== "" &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      });
    },
    getDirectories: (directoryName) => {
      const canonicalDirectory = lexicalAbsolutePath(
        directoryName,
        snapshot.packageRoot,
      );
      if (!containedLexicalPath(snapshot.packageRoot, canonicalDirectory)) {
        return [];
      }
      const directories = new Set<string>();
      for (const fileName of sourceFiles.keys()) {
        const relative = path.relative(canonicalDirectory, fileName);
        if (
          relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          continue;
        }
        const [first] = relative.split(path.sep);
        if (first) directories.add(first);
      }
      return [...directories].sort();
    },
    getSourceFile: (fileName, languageVersion) => {
      const member = snapshotMemberPath(snapshot, fileName);
      if (!member) return undefined;
      const content = sourceFiles.get(member);
      return content === undefined
        ? undefined
        : ts.createSourceFile(
            member,
            content,
            languageVersion,
            true,
            path.extname(member) === ".tsx"
              ? ts.ScriptKind.TSX
              : ts.ScriptKind.TS,
          );
    },
  });
}

function packageSourceFingerprint(
  snapshot: PackageSourceSnapshot,
): `sha256:${string}` {
  const sources = [...snapshot.files]
    .map(([file, content]) => ({
      file: path
        .relative(snapshot.packageRoot, file)
        .split(path.sep)
        .join(path.posix.sep),
      contentDigest: `sha256:${createHash("sha256")
        .update(content)
        .digest("hex")}`,
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const observedPaths = snapshot.observedPaths
    .map((file) =>
      path.relative(snapshot.packageRoot, file).split(path.sep).join(path.posix.sep),
    )
    .sort();
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        protocol: 3,
        complete: snapshot.complete,
        observedPaths,
        sources,
      }),
    )
    .digest("hex")}`;
}

export async function fingerprintSystemGraphPackageSources(
  packageRoot: string,
  readHooks: WorkflowSourceReadHooks = {},
): Promise<`sha256:${string}`> {
  return packageSourceFingerprint(
    await snapshotPackageSources(packageRoot, readHooks),
  );
}

export async function createSystemGraphPackageCompilerResult({
  packageRoot,
  generation = 1,
  readHooks = {},
}: SystemGraphPackageCompilerInput): Promise<SystemGraphPackageCompilerResult> {
  const snapshot = await snapshotPackageSources(packageRoot, readHooks);
  const program = createPackageProgram(snapshot);
  const checker = program.getTypeChecker();
  const sourceFilesByPath = new Map(
    program.getSourceFiles().map((sourceFile) => [
      lexicalAbsolutePath(sourceFile.fileName, snapshot.packageRoot),
      sourceFile,
    ]),
  );
  const sources = new Map<string, SystemGraphPackageSource>();
  for (const [file, source] of snapshot.files) {
    const sourceFile = sourceFilesByPath.get(file);
    if (!sourceFile) continue;
    sources.set(file, { path: file, source, sourceFile });
  }
  const methodAliases = collectInvocationMethodAliases(
    [...sources.values()].map((entry) => entry.sourceFile),
    checker,
  );
  const sourceFingerprint = packageSourceFingerprint(snapshot);
  return {
    packageKey: snapshot.packageRoot,
    packageRoot: snapshot.packageRoot,
    generation,
    program,
    checker,
    sources,
    observedPaths: snapshot.observedPaths,
    complete: snapshot.complete,
    sourceFingerprint,
    resolveInvocationTarget: (call) =>
      resolvePackageInvocationTarget(call, checker, methodAliases),
  };
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
  methodAliases: InvocationMethodAliasMap,
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
      const mode = packageInvocationMode(child, checker, methodAliases);
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
  invokedWrapperKeys: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
): string | null {
  for (
    let ancestor = node.parent;
    ancestor && ancestor !== sourceFile;
    ancestor = ancestor.parent
  ) {
    if (
      ts.isFunctionDeclaration(ancestor) ||
      ts.isFunctionExpression(ancestor) ||
      ts.isArrowFunction(ancestor)
    ) {
      const declaration =
        ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)
          ? ancestor.parent
          : ancestor;
      const symbol =
        ts.isFunctionDeclaration(declaration) && declaration.name
          ? checker.getSymbolAtLocation(declaration.name)
          : ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
              ? checker.getSymbolAtLocation(declaration.name)
              : undefined;
      const key = symbolKey(aliasedSymbol(checker, symbol));
      if (key && invokedWrapperKeys.has(key)) return key;
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
  generation = 1,
): Promise<Map<string, AgentInvocationProviderResult>> {
  const orderedCallers = [...callers].sort((left, right) =>
    callerInvocationCacheKey(left).localeCompare(callerInvocationCacheKey(right)),
  );
  const groupedCallers = new Map<string, AgentInventoryItem[]>();
  for (const caller of orderedCallers) {
    const packageRoot = packageRootForCaller(caller);
    const group = groupedCallers.get(packageRoot) ?? [];
    group.push(caller);
    groupedCallers.set(packageRoot, group);
  }

  const results = new Map<string, AgentInvocationProviderResult>();
  for (const [packageRoot, packageCallers] of [...groupedCallers].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const analysis = await createSystemGraphPackageCompilerResult({
      packageRoot,
      generation,
      readHooks,
    });
    const byCallerKey = new Map<string, PackageInvocationScan>();
    for (const caller of packageCallers) {
      byCallerKey.set(callerInvocationCacheKey(caller), {
        invocations: [],
        groupedInvocations: [],
        warnings: [],
        observedPaths: [...analysis.observedPaths],
        complete: analysis.complete,
        sourceFingerprint: analysis.sourceFingerprint,
      });
    }
    const sourceFiles = [...analysis.sources.values()]
      .map((entry) => entry.sourceFile)
      .filter(
        (sourceFile) =>
          !sourceFile.isDeclarationFile &&
          PROGRAM_SOURCE_EXTENSIONS.has(path.extname(sourceFile.fileName)) &&
          !sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`),
      )
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
    const methodAliases = collectInvocationMethodAliases(
      sourceFiles,
      analysis.checker,
    );
    const wrappers = new Map<
      string,
      Array<{ target: WrapperTargetResult; mode: AgentInvocationMode }>
    >();
    for (const sourceFile of sourceFiles) {
      const visit = (node: ts.Node): void => {
        const callable = functionLikeFromDeclaration(node as ts.Declaration);
        if (callable) {
          const symbol =
            ts.isFunctionDeclaration(node) && node.name
              ? analysis.checker.getSymbolAtLocation(node.name)
              : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
                ? analysis.checker.getSymbolAtLocation(node.name)
                : undefined;
          const key = symbolKey(aliasedSymbol(analysis.checker, symbol));
          const invocations = directInvocationsInFunction(
            callable,
            analysis.checker,
            methodAliases,
          );
          if (key && invocations.length > 0) wrappers.set(key, invocations);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    const invokedWrapperKeys = new Set<string>();
    for (const sourceFile of sourceFiles) {
      if (!owningCaller(sourceFile.fileName, packageCallers)) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          !analysis.resolveInvocationTarget(node)
        ) {
          const expression = unwrapTsExpression(node.expression);
          const symbol =
            ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
              ? aliasedSymbol(
                  analysis.checker,
                  analysis.checker.getSymbolAtLocation(expression),
                )
              : undefined;
          const key = symbolKey(symbol);
          if (key && wrappers.has(key)) invokedWrapperKeys.add(key);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    for (const sourceFile of sourceFiles) {
      const caller = owningCaller(sourceFile.fileName, packageCallers);
      if (!caller) continue;
      const scan = byCallerKey.get(callerInvocationCacheKey(caller))!;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const resolution = analysis.resolveInvocationTarget(node);
          const position = node.expression.getStart(sourceFile);
          if (resolution) {
            if (
              containingWrapperKey(
                node,
                analysis.checker,
                invokedWrapperKeys,
                sourceFile,
              )
            ) {
              ts.forEachChild(node, visit);
              return;
            }
            const evidence = relativeProgramEvidence(
              caller.sourceRoot,
              sourceFile.fileName,
              sourceFile,
              position,
            );
            if (resolution.kind === "resolved") {
              scan.invocations.push({
                target: resolution.target,
                mode: resolution.mode,
                evidence,
              });
            } else if (resolution.kind === "dynamic-target") {
              scan.warnings.push({
                code: "dynamic-target",
                mode: resolution.mode,
                evidence,
              });
            } else {
              for (const mode of resolution.modes) {
                scan.warnings.push({ code: "dynamic-target", mode, evidence });
              }
            }
          } else {
            const expression = unwrapTsExpression(node.expression);
            const symbol =
              ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
                ? aliasedSymbol(
                    analysis.checker,
                    analysis.checker.getSymbolAtLocation(expression),
                  )
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
                  analysis.checker,
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

    for (const [callerKey, scan] of byCallerKey) {
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
      scan.warnings.sort(
        (left, right) =>
          evidenceOrder(left.evidence, right.evidence) ||
          MODE_ORDER[left.mode] - MODE_ORDER[right.mode],
      );
      results.set(callerKey, {
        invocations: scan.groupedInvocations,
        warnings: scan.warnings,
        observedPaths: scan.observedPaths,
        complete: scan.complete,
        sourceFingerprint: scan.sourceFingerprint,
      });
    }
  }
  return results;
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
  private nextGeneration = 1;
  private inFlight:
    | {
        key: string;
        result: Promise<Map<string, AgentInvocationProviderResult>>;
      }
    | null = null;

  constructor(private readonly readHooks: WorkflowSourceReadHooks = {}) {}

  retainCallers(callers: readonly AgentInventoryItem[]): void {
    this.retainedCallers = [...callers].sort((left, right) =>
      callerInvocationCacheKey(left).localeCompare(callerInvocationCacheKey(right)),
    );
  }

  async listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult> {
    const callerKey = callerInvocationCacheKey(caller);
    const packageRoot = packageRootForCaller(caller);
    const retainedPackageCallers = this.retainedCallers.filter(
      (candidate) => packageRootForCaller(candidate) === packageRoot,
    );
    const callers = retainedPackageCallers.some(
      (candidate) => callerInvocationCacheKey(candidate) === callerKey,
    )
      ? retainedPackageCallers
      : [caller];
    const key = callers
      .map(callerInvocationCacheKey)
      .sort()
      .join("\0");
    if (!this.inFlight || this.inFlight.key !== key) {
      const generation = this.nextGeneration++;
      const result = scanPackageInvocations(
        callers,
        this.readHooks,
        generation,
      ).finally(() => {
        if (this.inFlight?.key === key) this.inFlight = null;
      });
      this.inFlight = { key, result };
    }
    const packageResult = await this.inFlight.result;
    return (
      packageResult.get(callerKey) ?? {
        invocations: [],
        warnings: [],
        observedPaths: [],
        complete: false,
      }
    );
  }
}
