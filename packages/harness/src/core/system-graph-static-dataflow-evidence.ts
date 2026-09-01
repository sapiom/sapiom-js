import { createHash } from "node:crypto";
import * as path from "node:path";
import ts from "typescript";

import {
  createPackageGraphEvidenceStaticResult,
  type PackageGraphEvidenceCoverageGap,
  type PackageGraphEvidenceDiagnostic,
  type PackageGraphEvidenceDigest,
  type PackageGraphEvidenceProducer,
  type PackageGraphEvidenceStaticResult,
  type PackageGraphStaticEvidenceCandidate,
  type PackageInventory,
} from "@sapiom/agent";

import type { SourceEvidence } from "./canvas-interconnections.js";
import {
  type SystemGraphPackageCompilerResult,
} from "./system-graph-relationships.js";
import type { AgentInventoryItem } from "./system-graph-inventory.js";

export const STATIC_DATAFLOW_EVIDENCE_PRODUCER = {
  id: "sapiom.harness.static-dataflow",
  version: "0.2.0",
} as const satisfies PackageGraphEvidenceProducer;

const EXTRACTOR_VERSION = "sap-3016-static-dataflow-v2";
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface StaticDataflowAnalysisInput {
  inventory: PackageInventory;
  agents: readonly AgentInventoryItem[];
  compiler: SystemGraphPackageCompilerResult;
}

export interface StaticDataflowAnalysisResult {
  result: PackageGraphEvidenceStaticResult;
  cacheable: boolean;
  complete: boolean;
}

interface FunctionRecord {
  key: string;
  file: StaticDataflowSourceFile;
  node: ts.FunctionLikeDeclaration;
}

interface FunctionSummary {
  returns: FlowValue;
  sinks: readonly SummarySink[];
  mutations: readonly SummaryMutation[];
  candidates: readonly PackageGraphStaticEvidenceCandidate[];
  complete: boolean;
}

interface SummarySink {
  targetAgentKey: string;
  destination: SourceEvidence;
  input: FlowValue;
}

interface SummaryMutation {
  parameterIndex: number;
  path: readonly AssignmentPathSegment[];
  value: FlowValue;
}

type SourceMap = Map<string, SourceEvidence[]>;

interface ParameterReference {
  index: number;
  path: readonly string[];
}

interface FlowValue {
  sources: SourceMap;
  properties: Map<string, FlowValue>;
  elements: Map<string, FlowValue>;
  propertyHazards: Set<string>;
  elementHazards: Set<string>;
  unknown: FlowValue | null;
  parameters: readonly ParameterReference[];
  references: readonly string[];
  opaque: boolean;
}

type Environment = Map<string, FlowValue>;

interface StatementResult {
  returns: FlowValue[];
  fallthrough: boolean;
  breaks: boolean;
  environment: Environment;
}

interface AnalysisContext {
  inventory: PackageInventory;
  compiler: SystemGraphPackageCompilerResult;
  sourceFiles: readonly StaticDataflowSourceFile[];
  targetAliases: ReadonlyMap<string, readonly AgentInventoryItem[]>;
  functions: Map<string, FunctionRecord>;
  rootFunctions: Set<string>;
  routingTables: Map<string, Map<string, string>>;
  summaries: Map<string, FunctionSummary>;
  candidates: PackageGraphStaticEvidenceCandidate[];
  markerSinks: SummarySink[];
  cycleStack: Set<string>;
  diagnostics: PackageGraphEvidenceDiagnostic[];
  coverageGaps: PackageGraphEvidenceCoverageGap[];
  nextReferenceId: number;
  complete: boolean;
}

interface StaticDataflowSourceFile {
  path: string;
  sourceFile: ts.SourceFile;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Static dataflow identity accepts JSON values only");
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): PackageGraphEvidenceDigest {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function analysisFingerprint(
  compiler: SystemGraphPackageCompilerResult,
): PackageGraphEvidenceDigest {
  if (DIGEST.test(compiler.sourceFingerprint)) {
    return digest({
      extractorVersion: EXTRACTOR_VERSION,
      sourceFingerprint: compiler.sourceFingerprint,
    });
  }
  return digest({
    extractorVersion: EXTRACTOR_VERSION,
    sources: [...compiler.sources.values()].map(({ path: sourcePath, source }) => ({
      path: sourcePath,
      contentDigest: digest(source),
    })),
  });
}

function canonicalSourcePath(
  compiler: SystemGraphPackageCompilerResult,
  sourcePath: string,
): string {
  const relative = path.relative(compiler.packageRoot, sourcePath);
  if (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return relative.split(path.sep).join(path.posix.sep);
  }
  return sourcePath.split(path.sep).join(path.posix.sep);
}

function sourceFiles(
  compiler: SystemGraphPackageCompilerResult,
): StaticDataflowSourceFile[] {
  return [...compiler.sources.values()]
    .filter((source) => !source.sourceFile.isDeclarationFile)
    .map((source) => ({
      path: canonicalSourcePath(compiler, source.path),
      sourceFile: source.sourceFile,
    }))
    .sort((left, right) => compareText(left.path, right.path));
}

function targetAliases(
  agents: readonly AgentInventoryItem[],
): ReadonlyMap<string, readonly AgentInventoryItem[]> {
  const aliases = new Map<string, AgentInventoryItem[]>();
  const addAlias = (alias: string, agent: AgentInventoryItem): void => {
    const matches = aliases.get(alias) ?? [];
    if (!matches.some((match) => match.agentKey === agent.agentKey)) {
      matches.push(agent);
      aliases.set(alias, matches);
    }
  };
  for (const agent of agents) {
    addAlias(agent.agentKey, agent);
    for (const alias of agent.resolutionAliases) addAlias(alias, agent);
  }
  return new Map(
    [...aliases].map(([alias, matches]) => [
      alias,
      matches.sort((left, right) => compareText(left.agentKey, right.agentKey)),
    ]),
  );
}

function targetAliasIdentity(
  agents: readonly AgentInventoryItem[],
): readonly unknown[] {
  return [...targetAliases(agents)]
    .map(([target, matches]) => ({
      target,
      agentKeys: matches.map((agent) => agent.agentKey),
    }))
    .sort((left, right) => compareText(left.target, right.target));
}

function resolveAgentTarget(
  context: AnalysisContext,
  target: string,
):
  | { kind: "resolved"; target: AgentInventoryItem }
  | { kind: "unknown" | "ambiguous" } {
  const exact = context.inventory.agents.find(
    (agent) => agent.agentKey === target,
  );
  if (exact) {
    const agent = [...context.targetAliases.values()]
      .flat()
      .find((candidate) => candidate.agentKey === exact.agentKey);
    if (agent) return { kind: "resolved", target: agent };
  }
  const matches = context.targetAliases.get(target) ?? [];
  if (matches.length === 1) return { kind: "resolved", target: matches[0]! };
  return { kind: matches.length === 0 ? "unknown" : "ambiguous" };
}

function unwrapTsExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return unwrapTsExpression(expression.expression);
  }
  return expression;
}

function objectPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
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

function symbolKey(symbol: ts.Symbol | undefined): string | null {
  const declarations = symbol?.declarations;
  if (!declarations || declarations.length === 0) return null;
  const declaration = declarations[0]!;
  const sourceFile = declaration.getSourceFile();
  return `${sourceFile.fileName}:${declaration.pos}:${declaration.end}`;
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

function resolvedObjectLiteral(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ts.ObjectLiteralExpression | null {
  const current = unwrapTsExpression(expression);
  if (ts.isObjectLiteralExpression(current)) return current;
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

function staticInvocationOptions(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.ObjectLiteralExpression | null {
  const argument = call.arguments[0];
  return argument ? resolvedObjectLiteral(checker, argument) : null;
}

function evidenceReference(kind: "source-callsite" | "dataflow-path", input: unknown) {
  return { kind, ref: `${kind}:${digest(input)}` };
}

function callsite(file: StaticDataflowSourceFile, node: ts.Node): SourceEvidence {
  const location = file.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(file.sourceFile),
  );
  return {
    file: file.path,
    line: location.line + 1,
    column: location.character + 1,
  };
}

function sourceCallsiteReference(source: SourceEvidence) {
  return evidenceReference("source-callsite", {
    protocol: 1,
    source,
  }) as { kind: "source-callsite"; ref: string };
}

function dataflowPathReference(source: SourceEvidence, destination: SourceEvidence) {
  return evidenceReference("dataflow-path", {
    protocol: 1,
    source,
    destination,
  }) as { kind: "dataflow-path"; ref: string };
}

function addPartialDiagnostic(
  context: AnalysisContext,
  code: PackageGraphEvidenceCoverageGap["code"],
  input: unknown,
): void {
  context.complete = false;
  const fingerprint = digest({
    producer: STATIC_DATAFLOW_EVIDENCE_PRODUCER,
    code,
    input,
  });
  context.coverageGaps.push({
    code,
    reference: evidenceReference("dataflow-path", { code, fingerprint }),
  });
  context.diagnostics.push({
    code:
      code === "dynamic-source" ? "dynamic-target" : "incomplete-analysis",
    severity: "warning",
    candidateFingerprint: fingerprint,
  });
}

function emptyValue(): FlowValue {
  return {
    sources: new Map(),
    properties: new Map(),
    elements: new Map(),
    propertyHazards: new Set(),
    elementHazards: new Set(),
    unknown: null,
    parameters: [],
    references: [],
    opaque: false,
  };
}

function valueFromSource(agentKey: string, source: SourceEvidence): FlowValue {
  return {
    ...emptyValue(),
    sources: new Map([[agentKey, [source]]]),
  };
}

function parameterValue(index: number): FlowValue {
  return {
    ...emptyValue(),
    parameters: [{ index, path: [] }],
    references: [`param:${index}`],
  };
}

function cloneValue(value: FlowValue): FlowValue {
  return {
    sources: new Map(
      [...value.sources.entries()].map(([key, refs]) => [key, [...refs]]),
    ),
    properties: new Map(
      [...value.properties.entries()].map(([key, child]) => [
        key,
        cloneValue(child),
      ]),
    ),
    elements: new Map(
      [...value.elements.entries()].map(([key, child]) => [
        key,
        cloneValue(child),
      ]),
    ),
    propertyHazards: new Set(value.propertyHazards),
    elementHazards: new Set(value.elementHazards),
    unknown: value.unknown ? cloneValue(value.unknown) : null,
    parameters: value.parameters.map((param) => ({
      index: param.index,
      path: [...param.path],
    })),
    references: [...value.references],
    opaque: value.opaque,
  };
}

function mergeSourceMaps(...sources: SourceMap[]): SourceMap {
  const merged: SourceMap = new Map();
  for (const source of sources) {
    for (const [key, refs] of source) {
      const current = merged.get(key) ?? [];
      current.push(...refs);
      merged.set(
        key,
        [...new Map(current.map((ref) => [`${ref.file}:${ref.line}:${ref.column}`, ref])).values()].sort(
          (left, right) =>
            compareText(left.file, right.file) ||
            left.line - right.line ||
            left.column - right.column,
        ),
      );
    }
  }
  return merged;
}

function mergeValues(...values: readonly FlowValue[]): FlowValue {
  const result = emptyValue();
  result.sources = mergeSourceMaps(...values.map((value) => value.sources));
  for (const value of values) {
    for (const [key, child] of value.properties) {
      result.properties.set(
        key,
        mergeValues(result.properties.get(key) ?? emptyValue(), child),
      );
    }
    for (const [key, child] of value.elements) {
      result.elements.set(
        key,
        mergeValues(result.elements.get(key) ?? emptyValue(), child),
      );
    }
    if (value.unknown) {
      result.unknown = mergeValues(result.unknown ?? emptyValue(), value.unknown);
    }
    result.parameters = [...result.parameters, ...value.parameters];
    result.references = [...result.references, ...value.references];
    for (const key of value.propertyHazards) result.propertyHazards.add(key);
    for (const key of value.elementHazards) result.elementHazards.add(key);
    result.opaque ||= value.opaque;
  }
  const seen = new Set<string>();
  result.parameters = result.parameters.filter((param) => {
    const key = `${param.index}:${param.path.join(".")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  result.references = [...new Set(result.references)].sort(compareText);
  return result;
}

function hasProvenance(value: FlowValue): boolean {
  return (
    value.opaque ||
    value.sources.size > 0 ||
    value.parameters.length > 0 ||
    [...value.properties.values()].some(hasProvenance) ||
    [...value.elements.values()].some(hasProvenance) ||
    (value.unknown ? hasProvenance(value.unknown) : false)
  );
}

function hasParameterReferences(value: FlowValue): boolean {
  return (
    value.parameters.length > 0 ||
    [...value.properties.values()].some(hasParameterReferences) ||
    [...value.elements.values()].some(hasParameterReferences) ||
    (value.unknown ? hasParameterReferences(value.unknown) : false)
  );
}

function hasConcreteProvenance(value: FlowValue): boolean {
  return (
    value.opaque ||
    value.sources.size > 0 ||
    [...value.properties.values()].some(hasConcreteProvenance) ||
    [...value.elements.values()].some(hasConcreteProvenance) ||
    (value.unknown ? hasConcreteProvenance(value.unknown) : false)
  );
}

function allSources(value: FlowValue): SourceMap {
  return mergeSourceMaps(
    value.sources,
    ...[...value.properties.values()].map(allSources),
    ...[...value.elements.values()].map(allSources),
    ...(value.unknown ? [allSources(value.unknown)] : []),
  );
}

function hasOwnSources(value: FlowValue): boolean {
  return value.sources.size > 0 || value.parameters.length > 0;
}

function selectPath(value: FlowValue, path: readonly string[]): FlowValue {
  let current = value;
  for (const key of path) {
    current = key.startsWith("#")
      ? selectElement(current, key.slice(1))
      : selectProperty(current, key);
  }
  return current;
}

function selectProperty(value: FlowValue, key: string): FlowValue {
  if (value.propertyHazards.has(key)) {
    return { ...emptyValue(), opaque: true };
  }
  const explicit = value.properties.get(key);
  return mergeValues(
    { ...emptyValue(), sources: new Map(value.sources) },
    explicit ?? value.unknown ?? emptyValue(),
    {
      ...emptyValue(),
      parameters: value.parameters.map((param) => ({
        index: param.index,
        path: [...param.path, key],
      })),
    },
  );
}

function selectElement(value: FlowValue, key: string): FlowValue {
  if (value.elementHazards.has(key)) {
    return { ...emptyValue(), opaque: true };
  }
  const explicit = value.elements.get(key);
  return mergeValues(
    { ...emptyValue(), sources: new Map(value.sources) },
    explicit ?? value.unknown ?? emptyValue(),
    {
      ...emptyValue(),
      parameters: value.parameters.map((param) => ({
        index: param.index,
        path: [...param.path, `#${key}`],
      })),
    },
  );
}

function objectRestWithout(value: FlowValue, keys: ReadonlySet<string>): FlowValue {
  const rest = {
    ...cloneValue(value),
    properties: new Map(
      [...value.properties.entries()]
        .filter(([key]) => !keys.has(key))
        .map(([key, child]) => [key, cloneValue(child)]),
    ),
    propertyHazards: new Set(
      [...value.propertyHazards].filter((key) => !keys.has(key)),
    ),
  };
  return rest;
}

function arrayRestFrom(value: FlowValue, start: number): FlowValue {
  const rest = {
    ...cloneValue(value),
    elements: new Map<string, FlowValue>(),
    elementHazards: new Set<string>(),
  };
  for (const [key, child] of value.elements) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < start) continue;
    rest.elements.set((index - start).toString(), cloneValue(child));
  }
  for (const key of value.elementHazards) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < start) continue;
    rest.elementHazards.add((index - start).toString());
  }
  return rest;
}

function withReference(value: FlowValue, context: AnalysisContext): FlowValue {
  return {
    ...value,
    references: [`ref:${context.nextReferenceId++}`],
  };
}

function withFreshReference(value: FlowValue, context: AnalysisContext): FlowValue {
  return {
    ...cloneValue(value),
    references: [`ref:${context.nextReferenceId++}`],
  };
}

function instantiateSummaryReferences(
  value: FlowValue,
  context: AnalysisContext,
  references = new Map<string, string>(),
): FlowValue {
  const next = cloneValue(value);
  next.references = value.references.map((reference) => {
    const existing = references.get(reference);
    if (existing) return existing;
    const replacement = `ref:${context.nextReferenceId++}`;
    references.set(reference, replacement);
    return replacement;
  });
  next.properties = new Map(
    [...value.properties.entries()].map(([key, child]) => [
      key,
      instantiateSummaryReferences(child, context, references),
    ]),
  );
  next.elements = new Map(
    [...value.elements.entries()].map(([key, child]) => [
      key,
      instantiateSummaryReferences(child, context, references),
    ]),
  );
  next.unknown = value.unknown
    ? instantiateSummaryReferences(value.unknown, context, references)
    : null;
  return next;
}

function referencesOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((reference) => rightSet.has(reference));
}

function updateReferencedPath(
  value: FlowValue,
  references: readonly string[],
  pathSegments: readonly AssignmentPathSegment[],
  assigned: FlowValue,
): FlowValue {
  if (referencesOverlap(value.references, references)) {
    return assignPath(value, pathSegments, assigned);
  }
  const next = cloneValue(value);
  for (const [key, child] of value.properties) {
    next.properties.set(
      key,
      updateReferencedPath(child, references, pathSegments, assigned),
    );
  }
  for (const [key, child] of value.elements) {
    next.elements.set(
      key,
      updateReferencedPath(child, references, pathSegments, assigned),
    );
  }
  if (value.unknown) {
    next.unknown = updateReferencedPath(
      value.unknown,
      references,
      pathSegments,
      assigned,
    );
  }
  return next;
}

function deletePath(
  value: FlowValue,
  pathSegments: readonly AssignmentPathSegment[],
): FlowValue {
  if (pathSegments.length === 0) return emptyValue();
  const [head, ...tail] = pathSegments;
  const next = cloneValue(value);
  if (head.kind === "property") {
    if (tail.length === 0) {
      next.properties.delete(head.key);
      next.propertyHazards.delete(head.key);
    } else {
      next.properties.set(
        head.key,
        deletePath(next.properties.get(head.key) ?? emptyValue(), tail),
      );
    }
  } else if (tail.length === 0) {
    next.elements.delete(head.key);
    next.elementHazards.delete(head.key);
  } else {
    next.elements.set(
      head.key,
      deletePath(next.elements.get(head.key) ?? emptyValue(), tail),
    );
  }
  return next;
}

function deleteReferencedPath(
  value: FlowValue,
  references: readonly string[],
  pathSegments: readonly AssignmentPathSegment[],
): FlowValue {
  if (referencesOverlap(value.references, references)) {
    return deletePath(value, pathSegments);
  }
  const next = cloneValue(value);
  for (const [key, child] of value.properties) {
    next.properties.set(key, deleteReferencedPath(child, references, pathSegments));
  }
  for (const [key, child] of value.elements) {
    next.elements.set(key, deleteReferencedPath(child, references, pathSegments));
  }
  if (value.unknown) {
    next.unknown = deleteReferencedPath(value.unknown, references, pathSegments);
  }
  return next;
}

function symbolIdentity(
  checker: ts.TypeChecker,
  node: ts.Node | undefined,
): string | null {
  if (!node) return null;
  return symbolKey(aliasedSymbol(checker, checker.getSymbolAtLocation(node)));
}

function shorthandValue(
  checker: ts.TypeChecker,
  property: ts.ShorthandPropertyAssignment,
  environment: Environment,
): FlowValue {
  const key = symbolKey(
    aliasedSymbol(checker, checker.getShorthandAssignmentValueSymbol(property)),
  );
  return key ? cloneValue(environment.get(key) ?? emptyValue()) : emptyValue();
}

function functionIdentity(
  checker: ts.TypeChecker,
  node: ts.FunctionLikeDeclaration,
): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return symbolIdentity(checker, node.name);
  }
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return symbolIdentity(checker, parent.name);
  }
  return null;
}

function isAgentSource(file: StaticDataflowSourceFile): boolean {
  return file.path === "agents" || file.path.startsWith("agents/");
}

function literalString(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  seen = new Set<string>(),
): string | null {
  if (!expression) return null;
  const current = unwrapTsExpression(expression);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  if (ts.isNumericLiteral(current)) return current.text;
  if (!ts.isIdentifier(current)) return null;
  const key = symbolIdentity(checker, current);
  if (!key || seen.has(key)) return null;
  seen.add(key);
  const symbol = aliasedSymbol(checker, checker.getSymbolAtLocation(current));
  for (const declaration of symbol?.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ) {
      const resolved = literalString(checker, declaration.initializer, seen);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

type AssignmentPathSegment =
  | { kind: "property"; key: string }
  | { kind: "element"; key: string };

interface AssignmentTarget {
  root: string;
  path: readonly AssignmentPathSegment[];
}

function isLogicalAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function isCompoundAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstCompoundAssignment &&
    kind <= ts.SyntaxKind.LastCompoundAssignment &&
    kind !== ts.SyntaxKind.BarBarEqualsToken &&
    kind !== ts.SyntaxKind.AmpersandAmpersandEqualsToken &&
    kind !== ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function assignmentTarget(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): AssignmentTarget | null {
  const current = unwrapTsExpression(expression);
  if (ts.isIdentifier(current)) {
    const root = symbolIdentity(checker, current);
    return root ? { root, path: [] } : null;
  }
  if (ts.isPropertyAccessExpression(current)) {
    const owner = assignmentTarget(checker, current.expression);
    return owner
      ? {
          root: owner.root,
          path: [...owner.path, { kind: "property", key: current.name.text }],
        }
      : null;
  }
  if (ts.isElementAccessExpression(current)) {
    const owner = assignmentTarget(checker, current.expression);
    const key = literalString(checker, current.argumentExpression);
    if (!owner || key === null) return null;
    return {
      root: owner.root,
      path: [
        ...owner.path,
        /^\d+$/.test(key)
          ? { kind: "element", key }
          : { kind: "property", key },
      ],
    };
  }
  return null;
}

function assignPath(
  value: FlowValue,
  pathSegments: readonly AssignmentPathSegment[],
  assigned: FlowValue,
): FlowValue {
  if (pathSegments.length === 0) return cloneValue(assigned);
  const [head, ...tail] = pathSegments;
  const next = cloneValue(value);
  if (head.kind === "property") {
    next.properties.set(
      head.key,
      assignPath(next.properties.get(head.key) ?? emptyValue(), tail, assigned),
    );
  } else {
    next.elements.set(
      head.key,
      assignPath(next.elements.get(head.key) ?? emptyValue(), tail, assigned),
    );
  }
  return next;
}

function selectedAssignmentBase(
  value: FlowValue,
  pathSegments: readonly AssignmentPathSegment[],
): { references: readonly string[]; path: readonly AssignmentPathSegment[] } {
  if (pathSegments.length === 0) return { references: value.references, path: [] };
  let current = value;
  for (const segment of pathSegments.slice(0, -1)) {
    current =
      segment.kind === "property"
        ? selectProperty(current, segment.key)
        : selectElement(current, segment.key);
  }
  return {
    references: current.references,
    path: pathSegments.slice(-1),
  };
}

function assignExpression(
  environment: Environment,
  checker: ts.TypeChecker,
  left: ts.Expression,
  right: FlowValue,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): Environment {
  const target = assignmentTarget(checker, left);
  if (!target) {
    if (hasProvenance(right)) {
      addPartialDiagnostic(context, "opaque-boundary", {
        reason: "unsupported-write",
        callsite: callsite(file, left),
      });
    }
    return environment;
  }
  const next = environment;
  const rootValue = next.get(target.root) ?? emptyValue();
  const base = selectedAssignmentBase(rootValue, target.path);
  if (base.path.length > 0 && base.references.length > 0) {
    for (const [key, value] of next) {
      next.set(
        key,
        updateReferencedPath(
          value,
          base.references,
          base.path,
          right,
        ),
      );
    }
  } else {
    next.set(target.root, assignPath(rootValue, target.path, right));
  }
  return next;
}

function deleteExpression(
  environment: Environment,
  checker: ts.TypeChecker,
  expression: ts.Expression,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): Environment {
  const target = assignmentTarget(checker, expression);
  if (!target) {
    const value = evaluateExpression(expression, environment, context, file);
    if (hasProvenance(value)) {
      addPartialDiagnostic(context, "opaque-boundary", {
        reason: "unsupported-delete",
        callsite: callsite(file, expression),
      });
    }
    return environment;
  }
  const next = environment;
  const rootValue = next.get(target.root) ?? emptyValue();
  const base = selectedAssignmentBase(rootValue, target.path);
  if (base.path.length > 0 && base.references.length > 0) {
    for (const [key, value] of next) {
      next.set(key, deleteReferencedPath(value, base.references, base.path));
    }
  } else {
    next.set(target.root, deletePath(rootValue, target.path));
  }
  return next;
}

function bindPattern(
  environment: Environment,
  checker: ts.TypeChecker,
  name: ts.BindingName,
  value: FlowValue,
  context?: AnalysisContext,
): void {
  if (ts.isIdentifier(name)) {
    const key = symbolIdentity(checker, name);
    if (key) environment.set(key, cloneValue(value));
    return;
  }
  const consumed = new Set<string>();
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      if (ts.isArrayBindingPattern(name)) consumed.add(consumed.size.toString());
      continue;
    }
    if (ts.isObjectBindingPattern(name)) {
      if (element.dotDotDotToken) {
        bindPattern(
          environment,
          checker,
          element.name,
          context
            ? withFreshReference(objectRestWithout(value, consumed), context)
            : objectRestWithout(value, consumed),
          context,
        );
        continue;
      }
      const key = element.propertyName
        ? objectPropertyName(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (!key) continue;
      consumed.add(key);
      bindPattern(
        environment,
        checker,
        element.name,
        selectProperty(value, key),
        context,
      );
    } else {
      const index = consumed.size.toString();
      if (element.dotDotDotToken) {
        bindPattern(
          environment,
          checker,
          element.name,
          context
            ? withFreshReference(arrayRestFrom(value, consumed.size), context)
            : arrayRestFrom(value, consumed.size),
          context,
        );
        continue;
      }
      consumed.add(index);
      bindPattern(
        environment,
        checker,
        element.name,
        selectElement(value, index),
        context,
      );
    }
  }
}

function invocationInput(
  call: ts.CallExpression,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
  seen = new Set<ts.ObjectLiteralExpression>(),
): FlowValue {
  const options = staticInvocationOptions(call, context.compiler.checker);
  if (!options || seen.has(options)) return emptyValue();
  seen.add(options);
  let input = emptyValue();
  let inputHazard: SourceEvidence | null = null;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      const object = resolvedObjectLiteral(
        context.compiler.checker,
        property.expression,
      );
      if (object) {
        const spreadInput = invocationInput(
          {
            ...call,
            arguments: ts.factory.createNodeArray([object]),
          } as ts.CallExpression,
          environment,
          context,
          file,
          seen,
        );
        if (hasProvenance(spreadInput)) {
          input = spreadInput;
          inputHazard = null;
        }
        continue;
      }
      const spread = evaluateExpression(
        property.expression,
        environment,
        context,
        file,
      );
      if (hasProvenance(spread)) {
        inputHazard = callsite(file, property);
        input = emptyValue();
      }
      continue;
    }
    if (
      ts.isPropertyAssignment(property) &&
      property.name &&
      objectPropertyName(property.name) === "input"
    ) {
      input = evaluateExpression(property.initializer, environment, context, file);
      inputHazard = null;
    }
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === "input"
    ) {
      input = shorthandValue(context.compiler.checker, property, environment);
      inputHazard = null;
    }
  }
  if (inputHazard) {
    addPartialDiagnostic(context, "opaque-boundary", {
      reason: "spread-options",
      callsite: inputHazard,
    });
    return emptyValue();
  }
  return input;
}

function emitSinkCandidates(
  context: AnalysisContext,
  targetAgentKey: string,
  input: FlowValue,
  destination: SourceEvidence,
): void {
  if (input.opaque) {
    addPartialDiagnostic(context, "opaque-boundary", {
      reason: "opaque-selection",
      destination,
    });
    return;
  }
  if (hasParameterReferences(input)) {
    context.markerSinks.push({ targetAgentKey, destination, input });
  }
  for (const [sourceKey, sources] of allSources(input)) {
    if (sourceKey === targetAgentKey) continue;
    for (const source of sources) {
      context.candidates.push({
        fromAgentKey: sourceKey,
        toAgentKey: targetAgentKey,
        relation: "feeds",
        basis: "static-dataflow",
        source: sourceCallsiteReference(source),
        destination: sourceCallsiteReference(destination),
        path: [dataflowPathReference(source, destination)],
      });
    }
  }
}

function instantiateSummaryValue(
  value: FlowValue,
  args: readonly FlowValue[],
  context: AnalysisContext,
  references = new Map<string, string>(),
): FlowValue {
  return mergeValues(
    {
      ...instantiateSummaryReferences(value, context, references),
      parameters: [],
      properties: new Map(
        [...value.properties.entries()].map(([key, child]) => [
          key,
          instantiateSummaryValue(child, args, context, references),
        ]),
      ),
      elements: new Map(
        [...value.elements.entries()].map(([key, child]) => [
          key,
          instantiateSummaryValue(child, args, context, references),
        ]),
      ),
      unknown: value.unknown
        ? instantiateSummaryValue(value.unknown, args, context, references)
        : null,
    },
    ...value.parameters.map((param) =>
      selectPath(args[param.index] ?? emptyValue(), param.path),
    ),
  );
}

function calledFunctionKey(
  expression: ts.Expression,
  context: AnalysisContext,
): string | null {
  const current = unwrapTsExpression(expression);
  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
    return symbolIdentity(context.compiler.checker, current);
  }
  return null;
}

function parameterPathSegments(
  pathSegments: readonly string[],
): AssignmentPathSegment[] | null {
  const path: AssignmentPathSegment[] = [];
  for (const segment of pathSegments) {
    if (segment === "*") return null;
    path.push(
      segment.startsWith("#")
        ? { kind: "element", key: segment.slice(1) }
        : { kind: "property", key: segment },
    );
  }
  return path;
}

function collectParameterMutations(
  value: FlowValue,
  pathSegments: readonly AssignmentPathSegment[] = [],
): SummaryMutation[] {
  const mutations: SummaryMutation[] = [];
  for (const parameter of value.parameters) {
    const parameterPath = parameterPathSegments(parameter.path);
    if (!parameterPath) continue;
    for (const [key, child] of value.properties) {
      mutations.push({
        parameterIndex: parameter.index,
        path: [
          ...parameterPath,
          ...pathSegments,
          { kind: "property" as const, key },
        ],
        value: cloneValue(child),
      });
    }
    for (const [key, child] of value.elements) {
      mutations.push({
        parameterIndex: parameter.index,
        path: [
          ...parameterPath,
          ...pathSegments,
          { kind: "element" as const, key },
        ],
        value: cloneValue(child),
      });
    }
  }
  for (const [key, child] of value.properties) {
    mutations.push(
      ...collectParameterMutations(
        child,
        [...pathSegments, { kind: "property" as const, key }],
      ),
    );
  }
  for (const [key, child] of value.elements) {
    mutations.push(
      ...collectParameterMutations(
        child,
        [...pathSegments, { kind: "element" as const, key }],
      ),
    );
  }
  return mutations;
}

function collectEnvironmentParameterMutations(
  environment: Environment,
): SummaryMutation[] {
  const mutations = new Map<string, SummaryMutation>();
  for (const [environmentKey, value] of [...environment].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    for (const mutation of collectParameterMutations(value)) {
      const key = `${mutation.parameterIndex}:${mutation.path
        .map((segment) => `${segment.kind}:${segment.key}`)
        .join("/")}:${environmentKey}`;
      mutations.set(key, mutation);
    }
  }
  return [...mutations.values()];
}

function routedFunctionKey(
  expression: ts.Expression,
  context: AnalysisContext,
): string | null {
  const current = unwrapTsExpression(expression);
  if (!ts.isElementAccessExpression(current)) return null;
  const tableKey = symbolIdentity(context.compiler.checker, current.expression);
  const routeKey = literalString(context.compiler.checker, current.argumentExpression);
  if (!tableKey || !routeKey) return null;
  return context.routingTables.get(tableKey)?.get(routeKey) ?? null;
}

function evaluateInvocation(
  call: ts.CallExpression,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): FlowValue {
  const destination = callsite(file, call.expression);
  const invocation = context.compiler.resolveInvocationTarget(call);
  if (!invocation) return emptyValue();
  if (invocation.kind === "dynamic-method" || invocation.kind === "dynamic-target") {
    addPartialDiagnostic(context, "dynamic-source", { destination });
    return emptyValue();
  }
  const resolution = resolveAgentTarget(context, invocation.target);
  if (resolution.kind !== "resolved") {
    addPartialDiagnostic(context, "opaque-boundary", {
      reason: resolution.kind === "ambiguous" ? "ambiguous-target" : "unknown-target",
      target: digest(invocation.target),
      destination,
    });
    return emptyValue();
  }
  emitSinkCandidates(
    context,
    resolution.target.agentKey,
    invocationInput(call, environment, context, file),
    destination,
  );
  return invocation.mode === "blocking"
    ? valueFromSource(resolution.target.agentKey, destination)
    : emptyValue();
}

function evaluateExpression(
  expression: ts.Expression | undefined,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): FlowValue {
  if (!expression) return emptyValue();
  const current = unwrapTsExpression(expression);
  if (ts.isIdentifier(current)) {
    const key = symbolIdentity(context.compiler.checker, current);
    return key ? cloneValue(environment.get(key) ?? emptyValue()) : emptyValue();
  }
  if (ts.isPropertyAccessExpression(current)) {
    return selectProperty(
      evaluateExpression(current.expression, environment, context, file),
      current.name.text,
    );
  }
  if (ts.isElementAccessExpression(current)) {
    const key = literalString(context.compiler.checker, current.argumentExpression);
    if (key === null) {
      const owner = evaluateExpression(current.expression, environment, context, file);
      if (hasProvenance(owner)) {
        addPartialDiagnostic(context, "opaque-boundary", {
          reason: "dynamic-property",
          callsite: callsite(file, current.argumentExpression ?? current),
        });
      }
      return emptyValue();
    }
    const owner = evaluateExpression(current.expression, environment, context, file);
    return /^\d+$/.test(key)
      ? selectElement(owner, key)
      : selectProperty(owner, key);
  }
  if (ts.isObjectLiteralExpression(current)) {
    const value = withReference(emptyValue(), context);
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = evaluateExpression(
          property.expression,
          environment,
          context,
          file,
        );
        if (
          value.properties.size > 0 &&
          (hasOwnSources(spread) || spread.unknown || spread.opaque)
        ) {
          for (const key of value.properties.keys()) {
            value.propertyHazards.add(key);
          }
        }
        for (const [key, child] of spread.properties) {
          value.properties.set(key, cloneValue(child));
          if (!spread.unknown && !hasOwnSources(spread) && !spread.opaque) {
            value.propertyHazards.delete(key);
          }
        }
        for (const key of spread.propertyHazards) {
          value.propertyHazards.add(key);
        }
        value.unknown = mergeValues(
          value.unknown ?? emptyValue(),
          {
            ...spread,
            properties: new Map(),
            elements: new Map(),
          parameters: spread.parameters.map((param) => ({
            index: param.index,
            path: [...param.path, "*"],
          })),
          },
        );
        continue;
      }
      if (ts.isPropertyAssignment(property) && property.name) {
        const key = objectPropertyName(property.name);
        if (key) {
          value.properties.set(
            key,
            evaluateExpression(property.initializer, environment, context, file),
          );
          value.propertyHazards.delete(key);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        value.properties.set(
          property.name.text,
          shorthandValue(context.compiler.checker, property, environment),
        );
        value.propertyHazards.delete(property.name.text);
      }
    }
    return value;
  }
  if (ts.isArrayLiteralExpression(current)) {
    const value = withReference(emptyValue(), context);
    let nextIndex = 0;
    for (const element of current.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = evaluateExpression(
          element.expression,
          environment,
          context,
          file,
        );
        if (
          spread.sources.size > 0 ||
          spread.parameters.length > 0 ||
          spread.unknown ||
          spread.opaque
        ) {
          if (hasProvenance(spread)) {
            addPartialDiagnostic(context, "opaque-boundary", {
              reason: "unknown-array-spread",
              callsite: callsite(file, element),
            });
          }
          continue;
        }
        const indexes = [...spread.elements.keys()]
          .map(Number)
          .filter(Number.isInteger)
          .sort((left, right) => left - right);
        for (const index of indexes) {
          const child = spread.elements.get(index.toString());
          if (!child) continue;
          value.elements.set((nextIndex + index).toString(), cloneValue(child));
        }
        for (const key of spread.elementHazards) {
          const index = Number(key);
          if (Number.isInteger(index)) {
            value.elementHazards.add((nextIndex + index).toString());
          }
        }
        if (indexes.length > 0) nextIndex += Math.max(...indexes) + 1;
      } else {
        value.elements.set(
          nextIndex.toString(),
          evaluateExpression(element, environment, context, file),
        );
        value.elementHazards.delete(nextIndex.toString());
        nextIndex += 1;
      }
    }
    return value;
  }
  if (ts.isDeleteExpression(current)) {
    deleteExpression(
      environment,
      context.compiler.checker,
      current.expression,
      context,
      file,
    );
    return emptyValue();
  }
  if (ts.isTemplateExpression(current)) {
    return mergeValues(
      ...current.templateSpans.map((span) =>
        evaluateExpression(span.expression, environment, context, file),
      ),
    );
  }
  if (ts.isBinaryExpression(current)) {
    if (current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const right = evaluateExpression(current.right, environment, context, file);
      if (ts.isExpression(current.left)) {
        assignExpression(
          environment,
          context.compiler.checker,
          unwrapTsExpression(current.left),
          right,
          context,
          file,
        );
      }
      return right;
    }
    if (isLogicalAssignmentOperator(current.operatorToken.kind)) {
      const left = evaluateExpression(current.left, environment, context, file);
      const right = evaluateExpression(current.right, environment, context, file);
      const assigned = mergeValues(left, right);
      assignExpression(
        environment,
        context.compiler.checker,
        unwrapTsExpression(current.left),
        assigned,
        context,
        file,
      );
      return assigned;
    }
    if (isCompoundAssignmentOperator(current.operatorToken.kind)) {
      const left = evaluateExpression(current.left, environment, context, file);
      const right = evaluateExpression(current.right, environment, context, file);
      const assigned =
        hasProvenance(left) || hasProvenance(right)
          ? { ...emptyValue(), opaque: true }
          : emptyValue();
      if (assigned.opaque) {
        addPartialDiagnostic(context, "opaque-boundary", {
          reason: "unsupported-assignment",
          callsite: callsite(file, current.operatorToken),
        });
      }
      assignExpression(
        environment,
        context.compiler.checker,
        unwrapTsExpression(current.left),
        assigned,
        context,
        file,
      );
      return assigned;
    }
    return mergeValues(
      evaluateExpression(current.left, environment, context, file),
      evaluateExpression(current.right, environment, context, file),
    );
  }
  if (ts.isConditionalExpression(current)) {
    return mergeValues(
      evaluateExpression(current.whenTrue, environment, context, file),
      evaluateExpression(current.whenFalse, environment, context, file),
    );
  }
  if (ts.isNewExpression(current)) {
    const args = current.arguments?.map((arg) =>
      evaluateExpression(arg, environment, context, file),
    ) ?? [];
    if (args.some(hasProvenance)) {
      addPartialDiagnostic(context, "opaque-boundary", {
        reason: "constructor",
        callsite: callsite(file, current.expression),
      });
    }
    return emptyValue();
  }
  if (!ts.isCallExpression(current)) return emptyValue();

  const invocation = context.compiler.resolveInvocationTarget(current);
  if (invocation) {
    return evaluateInvocation(current, environment, context, file);
  }

  const args = current.arguments.map((argument) =>
    evaluateExpression(argument, environment, context, file),
  );
  const routed = routedFunctionKey(current.expression, context);
  const key = routed ?? calledFunctionKey(current.expression, context);
  if (key && context.functions.has(key)) {
    return evaluateFunction(key, args, context, environment);
  }
  if (args.some(hasProvenance)) {
    addPartialDiagnostic(context, "opaque-boundary", {
      reason:
        ts.isIdentifier(unwrapTsExpression(current.expression)) &&
        unwrapTsExpression(current.expression).getText(file.sourceFile) === "eval"
          ? "dynamic-reflection"
          : "unsupported-transform",
      callsite: callsite(file, current.expression),
    });
  }
  return emptyValue();
}

function mergeEnvironments(...environments: readonly Environment[]): Environment {
  const merged: Environment = new Map();
  for (const environment of environments) {
    for (const [key, value] of environment) {
      merged.set(key, mergeValues(merged.get(key) ?? emptyValue(), value));
    }
  }
  return merged;
}

function bindAssignmentPattern(
  environment: Environment,
  checker: ts.TypeChecker,
  pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  value: FlowValue,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): Environment {
  let next = new Map(environment);
  if (ts.isObjectLiteralExpression(pattern)) {
    const consumed = new Set<string>();
    for (const property of pattern.properties) {
      if (ts.isSpreadAssignment(property)) {
        next = assignExpression(
          next,
          checker,
          property.expression,
          withFreshReference(objectRestWithout(value, consumed), context),
          context,
          file,
        );
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const key = property.name.text;
        consumed.add(key);
        next = assignExpression(
          next,
          checker,
          property.name,
          selectProperty(value, key),
          context,
          file,
        );
        continue;
      }
      if (!ts.isPropertyAssignment(property) || !property.name) {
        if (hasProvenance(value)) {
          addPartialDiagnostic(context, "opaque-boundary", {
            reason: "unsupported-destructuring-assignment",
            callsite: callsite(file, property),
          });
        }
        continue;
      }
      const key = objectPropertyName(property.name);
      if (!key || !ts.isExpression(property.initializer)) {
        if (hasProvenance(value)) {
          addPartialDiagnostic(context, "opaque-boundary", {
            reason: "unsupported-destructuring-assignment",
            callsite: callsite(file, property),
          });
        }
        continue;
      }
      consumed.add(key);
      const selected = selectProperty(value, key);
      const target = unwrapTsExpression(property.initializer);
      if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
        next = bindAssignmentPattern(next, checker, target, selected, context, file);
      } else {
        next = assignExpression(next, checker, target, selected, context, file);
      }
    }
    return next;
  }
  let index = 0;
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) {
      index += 1;
      continue;
    }
    if (ts.isSpreadElement(element)) {
      next = assignExpression(
        next,
        checker,
        element.expression,
        withFreshReference(arrayRestFrom(value, index), context),
        context,
        file,
      );
      continue;
    }
    const selected = selectElement(value, index.toString());
    const target = unwrapTsExpression(element);
    if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
      next = bindAssignmentPattern(next, checker, target, selected, context, file);
    } else {
      next = assignExpression(next, checker, target, selected, context, file);
    }
    index += 1;
  }
  return next;
}

function analyzeSwitchStatement(
  statement: ts.SwitchStatement,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): StatementResult {
  const expressionFlow = evaluateExpression(
    statement.expression,
    environment,
    context,
    file,
  );
  const selectedCase = literalString(context.compiler.checker, statement.expression);
  if (selectedCase === null && hasConcreteProvenance(expressionFlow)) {
    addPartialDiagnostic(context, "opaque-boundary", {
      reason: "dynamic-switch",
      callsite: callsite(file, statement.expression),
    });
    return { returns: [], fallthrough: true, breaks: false, environment };
  }

  const clauses = statement.caseBlock.clauses;
  const startIndexes: number[] = [];
  if (selectedCase === null) {
    startIndexes.push(...clauses.map((_, index) => index));
  } else {
    const matched = clauses.findIndex(
      (clause) =>
        ts.isCaseClause(clause) &&
        literalString(context.compiler.checker, clause.expression) === selectedCase,
    );
    if (matched >= 0) {
      startIndexes.push(matched);
    } else {
      const defaultIndex = clauses.findIndex(ts.isDefaultClause);
      if (defaultIndex >= 0) startIndexes.push(defaultIndex);
    }
  }

  const results: StatementResult[] = [];
  for (const start of startIndexes) {
    const branchStatements: ts.Statement[] = [];
    for (let index = start; index < clauses.length; index += 1) {
      branchStatements.push(...clauses[index]!.statements);
      if (clauses[index]!.statements.some(ts.isBreakStatement)) break;
    }
    results.push(analyzeStatements(branchStatements, new Map(environment), context, file));
  }
  if (results.length === 0) {
    return { returns: [], fallthrough: true, breaks: false, environment };
  }
  const exitEnvironments = results
    .filter((result) => result.fallthrough || result.breaks)
    .map((result) => result.environment);
  return {
    returns: results.flatMap((result) => result.returns),
    fallthrough: exitEnvironments.length > 0,
    breaks: false,
    environment:
      exitEnvironments.length > 0
        ? mergeEnvironments(...exitEnvironments)
        : environment,
  };
}

function nodeReferencesProvenance(
  node: ts.Node,
  environment: Environment,
  context: AnalysisContext,
): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== node && ts.isFunctionLike(child)) return;
    if (ts.isIdentifier(child)) {
      const key = symbolIdentity(context.compiler.checker, child);
      if (key && hasProvenance(environment.get(key) ?? emptyValue())) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function nodeContainsAgentInvocation(
  node: ts.Node,
  context: AnalysisContext,
): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== node && ts.isFunctionLike(child)) return;
    if (
      ts.isCallExpression(child) &&
      context.compiler.resolveInvocationTarget(child)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isolatedProbeContext(context: AnalysisContext): AnalysisContext {
  return {
    ...context,
    candidates: [],
    markerSinks: [],
    diagnostics: [],
    coverageGaps: [],
    nextReferenceId: context.nextReferenceId,
    complete: true,
  };
}

function expressionTouchesProvenanceOrEffects(
  expression: ts.Expression,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): boolean {
  const probe = isolatedProbeContext(context);
  const value = evaluateExpression(expression, new Map(environment), probe, file);
  return (
    hasProvenance(value) ||
    !probe.complete ||
    probe.candidates.length > 0 ||
    probe.markerSinks.length > 0
  );
}

function nodeContainsFunctionEffects(
  node: ts.Node,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== node && ts.isFunctionLike(child)) return;
    if (ts.isCallExpression(child)) {
      const probe = isolatedProbeContext(context);
      const args = child.arguments.map((argument) =>
        evaluateExpression(argument, new Map(environment), probe, file),
      );
      const key =
        routedFunctionKey(child.expression, context) ??
        calledFunctionKey(child.expression, context);
      if (key && context.functions.has(key)) {
        const summary = summarizeFunction(key, context);
        found =
          !summary.complete ||
          !probe.complete ||
          probe.candidates.length > 0 ||
          probe.markerSinks.length > 0 ||
          summary.candidates.length > 0 ||
          summary.sinks.length > 0 ||
          summary.mutations.length > 0 ||
          hasProvenance(instantiateSummaryValue(summary.returns, args, probe));
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function loopTouchesProvenance(
  statement:
    | ts.WhileStatement
    | ts.DoStatement
    | ts.ForStatement
    | ts.ForOfStatement
    | ts.ForInStatement,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): boolean {
  const expressions: ts.Expression[] = [];
  if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
    expressions.push(statement.expression);
  } else if (ts.isForStatement(statement)) {
    if (statement.initializer && ts.isExpression(statement.initializer)) {
      expressions.push(statement.initializer);
    } else if (
      statement.initializer &&
      ts.isVariableDeclarationList(statement.initializer)
    ) {
      for (const declaration of statement.initializer.declarations) {
        if (declaration.initializer) expressions.push(declaration.initializer);
      }
    }
    if (statement.condition) expressions.push(statement.condition);
    if (statement.incrementor) expressions.push(statement.incrementor);
  } else {
    expressions.push(statement.expression);
  }
  return (
    expressions.some((expression) =>
      expressionTouchesProvenanceOrEffects(expression, environment, context, file),
    ) ||
    nodeReferencesProvenance(statement.statement, environment, context) ||
    nodeContainsAgentInvocation(statement.statement, context) ||
    nodeContainsFunctionEffects(statement.statement, environment, context, file)
  );
}

function analyzeStatement(
  statement: ts.Statement,
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): StatementResult {
  if (ts.isVariableStatement(statement)) {
    const next = new Map(environment);
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
        ? unwrapTsExpression(declaration.initializer)
        : undefined;
      if (
        initializer &&
        ts.isBinaryExpression(initializer) &&
        initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isExpression(initializer.left)
      ) {
        const right = evaluateExpression(
          initializer.right,
          next,
          context,
          file,
        );
        assignExpression(
          next,
          context.compiler.checker,
          unwrapTsExpression(initializer.left),
          right,
          context,
          file,
        );
        bindPattern(next, context.compiler.checker, declaration.name, right, context);
        continue;
      }
      bindPattern(
        next,
        context.compiler.checker,
        declaration.name,
        evaluateExpression(declaration.initializer, next, context, file),
        context,
      );
    }
    return { returns: [], fallthrough: true, breaks: false, environment: next };
  }
  if (ts.isExpressionStatement(statement)) {
    const expression = unwrapTsExpression(statement.expression);
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isExpression(expression.left)
    ) {
      const right = evaluateExpression(expression.right, environment, context, file);
      const left = unwrapTsExpression(expression.left);
      const next =
        ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)
          ? bindAssignmentPattern(
              environment,
              context.compiler.checker,
              left,
              right,
              context,
              file,
            )
          : assignExpression(
              environment,
              context.compiler.checker,
              left,
              right,
              context,
              file,
            );
      return { returns: [], fallthrough: true, breaks: false, environment: next };
    }
    evaluateExpression(expression, environment, context, file);
    return { returns: [], fallthrough: true, breaks: false, environment };
  }
  if (ts.isReturnStatement(statement)) {
    return {
      returns: [evaluateExpression(statement.expression, environment, context, file)],
      fallthrough: false,
      breaks: false,
      environment,
    };
  }
  if (ts.isIfStatement(statement)) {
    const condition = evaluateExpression(
      statement.expression,
      environment,
      context,
      file,
    );
    if (hasConcreteProvenance(condition)) {
      addPartialDiagnostic(context, "opaque-boundary", {
        reason: "provenance-condition",
        callsite: callsite(file, statement.expression),
      });
    }
    const thenResult = analyzeStatements(
      ts.isBlock(statement.thenStatement)
        ? statement.thenStatement.statements
        : [statement.thenStatement],
      new Map(environment),
      context,
      file,
    );
    const elseResult = statement.elseStatement
      ? analyzeStatements(
          ts.isBlock(statement.elseStatement)
            ? statement.elseStatement.statements
            : [statement.elseStatement],
          new Map(environment),
          context,
          file,
        )
      : { returns: [], fallthrough: true, breaks: false, environment };
    const fallthroughEnvs = [
      ...(thenResult.fallthrough ? [thenResult.environment] : []),
      ...(elseResult.fallthrough ? [elseResult.environment] : []),
    ];
    return {
      returns: [...thenResult.returns, ...elseResult.returns],
      fallthrough: fallthroughEnvs.length > 0,
      breaks: thenResult.breaks || elseResult.breaks,
      environment:
        fallthroughEnvs.length > 0
          ? mergeEnvironments(...fallthroughEnvs)
          : environment,
    };
  }
  if (ts.isBlock(statement)) {
    return analyzeStatements(statement.statements, environment, context, file);
  }
  if (ts.isSwitchStatement(statement)) {
    return analyzeSwitchStatement(statement, environment, context, file);
  }
  if (
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isForInStatement(statement)
  ) {
    if (loopTouchesProvenance(statement, environment, context, file)) {
      addPartialDiagnostic(context, "opaque-boundary", {
        reason: "unsupported-loop",
        callsite: callsite(file, statement),
      });
    }
    return { returns: [], fallthrough: true, breaks: false, environment };
  }
  if (ts.isBreakStatement(statement)) {
    return { returns: [], fallthrough: false, breaks: true, environment };
  }
  return { returns: [], fallthrough: true, breaks: false, environment };
}

function analyzeStatements(
  statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  environment: Environment,
  context: AnalysisContext,
  file: StaticDataflowSourceFile,
): StatementResult {
  const returns: FlowValue[] = [];
  let current = environment;
  for (const statement of statements) {
    const result = analyzeStatement(statement, current, context, file);
    returns.push(...result.returns);
    if (!result.fallthrough || result.breaks) {
      return {
        returns,
        fallthrough: false,
        breaks: result.breaks,
        environment: result.environment,
      };
    }
    current = result.environment;
  }
  return { returns, fallthrough: true, breaks: false, environment: current };
}

function evaluateFunction(
  key: string,
  args: readonly FlowValue[],
  context: AnalysisContext,
  environment?: Environment,
): FlowValue {
  const summary = summarizeFunction(key, context);
  if (!summary.complete) context.complete = false;
  context.candidates.push(...summary.candidates);
  if (environment) {
    for (const mutation of summary.mutations) {
      const arg = args[mutation.parameterIndex] ?? emptyValue();
      const value = instantiateSummaryValue(mutation.value, args, context);
      if (arg.references.length > 0) {
        for (const [environmentKey, environmentValue] of environment) {
          environment.set(
            environmentKey,
            updateReferencedPath(
              environmentValue,
              arg.references,
              mutation.path,
              value,
            ),
          );
        }
      } else if (hasProvenance(value)) {
        addPartialDiagnostic(context, "opaque-boundary", {
          reason: "unsupported-helper-mutation",
          functionKey: digest(key),
        });
      }
    }
  }
  for (const sink of summary.sinks) {
    emitSinkCandidates(
      context,
      sink.targetAgentKey,
      instantiateSummaryValue(sink.input, args, context),
      sink.destination,
    );
  }
  return instantiateSummaryValue(summary.returns, args, context);
}

function summarizeFunction(
  key: string,
  context: AnalysisContext,
): FunctionSummary {
  const cached = context.summaries.get(key);
  if (cached) return cached;
  if (context.cycleStack.has(key)) {
    addPartialDiagnostic(context, "opaque-boundary", {
      reason: "cycle",
      functionKey: digest(key),
    });
    return {
      returns: emptyValue(),
      sinks: [],
      mutations: [],
      candidates: [],
      complete: false,
    };
  }
  const record = context.functions.get(key);
  if (!record?.node.body) {
    return {
      returns: emptyValue(),
      sinks: [],
      mutations: [],
      candidates: [],
      complete: true,
    };
  }
  context.cycleStack.add(key);
  const nested: AnalysisContext = {
    ...context,
    candidates: [],
    markerSinks: [],
    summaries: context.summaries,
    cycleStack: context.cycleStack,
  };
  const environment: Environment = new Map();
  record.node.parameters.forEach((parameter, index) => {
    bindPattern(
      environment,
      context.compiler.checker,
      parameter.name,
      parameterValue(index),
      context,
    );
  });
  const body = ts.isBlock(record.node.body)
    ? record.node.body.statements
    : [ts.factory.createReturnStatement(record.node.body)];
  const result = analyzeStatements(body, environment, nested, record.file);
  const summary: FunctionSummary = {
    returns: mergeValues(...result.returns),
    sinks: [...nested.markerSinks],
    mutations: collectEnvironmentParameterMutations(result.environment),
    candidates: normalizeCandidates(nested.candidates),
    complete: nested.complete,
  };
  context.cycleStack.delete(key);
  context.summaries.set(key, summary);
  return summary;
}

function collectTopLevel(context: AnalysisContext): void {
  for (const file of context.sourceFiles) {
    for (const statement of file.sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const key = functionIdentity(context.compiler.checker, statement);
        if (key) {
          context.functions.set(key, { key, file, node: statement });
          if (
            isAgentSource(file) &&
            statement.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            )
          ) {
            context.rootFunctions.add(key);
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            continue;
          }
          const declarationKey = symbolIdentity(
            context.compiler.checker,
            declaration.name,
          );
          const initializer = unwrapTsExpression(declaration.initializer);
          if (
            ts.isFunctionExpression(initializer) ||
            ts.isArrowFunction(initializer)
          ) {
            const key = functionIdentity(context.compiler.checker, initializer);
            if (key) {
              context.functions.set(key, { key, file, node: initializer });
              if (exported && isAgentSource(file)) context.rootFunctions.add(key);
            }
          } else if (declarationKey && ts.isObjectLiteralExpression(initializer)) {
            const table = new Map<string, string>();
            for (const property of initializer.properties) {
              if (!ts.isPropertyAssignment(property) || !property.name) continue;
              const route = objectPropertyName(property.name);
              const target = calledFunctionKey(property.initializer, context);
              if (route && target) table.set(route, target);
            }
            if (table.size > 0) context.routingTables.set(declarationKey, table);
          }
        }
      }
    }
  }
}

function normalizeCandidates(
  candidates: readonly PackageGraphStaticEvidenceCandidate[],
): PackageGraphStaticEvidenceCandidate[] {
  return [
    ...new Map(
      [...candidates]
        .sort((left, right) =>
          compareText(left.fromAgentKey, right.fromAgentKey) ||
          compareText(left.toAgentKey, right.toAgentKey) ||
          compareText(left.basis, right.basis) ||
          compareText(stableJson(left), stableJson(right)),
        )
        .map((candidate) => [stableJson(candidate), candidate]),
    ).values(),
  ];
}

function compilerCacheIdentity(
  input: StaticDataflowAnalysisInput,
): Record<string, unknown> {
  return {
    packageKey: input.compiler.packageKey,
    packageRoot: input.compiler.packageRoot,
    generation: input.compiler.generation,
    sourceFingerprint: input.compiler.sourceFingerprint,
    complete: input.compiler.complete,
    observedPaths: [...input.compiler.observedPaths].sort(),
    sources: sourceFiles(input.compiler).map((source) => source.path),
    targets: targetAliasIdentity(input.agents),
  };
}

export class StaticDataflowSummaryCache {
  private readonly results = new Map<string, StaticDataflowAnalysisResult>();

  getOrAnalyze(input: StaticDataflowAnalysisInput): StaticDataflowAnalysisResult {
    const key = stableJson({
      extractorVersion: EXTRACTOR_VERSION,
      scope: input.inventory.version,
      fingerprint: analysisFingerprint(input.compiler),
      compiler: compilerCacheIdentity(input),
    });
    const cached = this.results.get(key);
    if (cached) return cached;
    const result = analyzeStaticDataflow(input);
    if (result.cacheable) this.results.set(key, result);
    return result;
  }
}

export function analyzeStaticDataflow(
  input: StaticDataflowAnalysisInput,
): StaticDataflowAnalysisResult {
  const files = sourceFiles(input.compiler);
  const context: AnalysisContext = {
    inventory: input.inventory,
    compiler: input.compiler,
    sourceFiles: files,
    targetAliases: targetAliases(input.agents),
    functions: new Map(),
    rootFunctions: new Set(),
    routingTables: new Map(),
    summaries: new Map(),
    candidates: [],
    markerSinks: [],
    cycleStack: new Set(),
    diagnostics: [],
    coverageGaps: [],
    nextReferenceId: 1,
    complete: true,
  };
  if (!input.compiler.complete) {
    addPartialDiagnostic(context, "opaque-boundary", {
      reason: "incomplete-compiler-scan",
      packageKey: input.compiler.packageKey,
    });
  }
  collectTopLevel(context);
  for (const key of [...context.rootFunctions].sort(compareText)) {
    evaluateFunction(key, [], context);
  }
  for (const file of files) {
    analyzeStatements(file.sourceFile.statements, new Map(), context, file);
  }
  if (
    !context.complete &&
    !context.diagnostics.some(
      (diagnostic) => diagnostic.code === "incomplete-analysis",
    )
  ) {
    context.diagnostics.push({
      code: "incomplete-analysis",
      severity: "warning",
    });
  }
  const coverage = context.complete
    ? { status: "complete" as const }
    : {
        status: "partial" as const,
        gaps:
          context.coverageGaps.length > 0
            ? context.coverageGaps
            : [{ code: "other" as const }],
      };
  const result = createPackageGraphEvidenceStaticResult(
    {
      scope: input.inventory.version,
      producer: STATIC_DATAFLOW_EVIDENCE_PRODUCER,
      analysisFingerprint: analysisFingerprint(input.compiler),
      outcome: "success",
      coverage,
      candidates: normalizeCandidates(context.candidates),
      diagnostics: context.diagnostics,
    },
    input.inventory,
  );
  return {
    result,
    cacheable: context.complete && input.compiler.complete,
    complete: context.complete,
  };
}
