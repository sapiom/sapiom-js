/**
 * Syntax-only discovery of an agent exported from a candidate `index.ts`.
 *
 * This module deliberately creates no TypeScript Program or TypeChecker and
 * never imports, bundles, type-checks, or executes project code. It follows
 * only relative TypeScript imports that are needed to resolve the entry
 * module's exports, within the candidate directory and explicit budgets.
 */
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

import { isAgentProjectScanIgnoredDir } from "./agent-project-discovery.js";

export const AGENT_SOURCE_ENTRYPOINT = "index.ts";
export const AGENT_SOURCE_MAX_IMPORT_DEPTH = 8;
export const AGENT_SOURCE_MAX_MODULES_PER_CANDIDATE = 32;
export const AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE = 1024 * 1024;
export const AGENT_SOURCE_MAX_MODULES_PER_SCAN = 2_000;
export const AGENT_SOURCE_MAX_BYTES_PER_SCAN = 16 * 1024 * 1024;
export const AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES = 10_000;
export const AGENT_SOURCE_MAX_LOOKUPS_PER_CANDIDATE = 256;
export const AGENT_SOURCE_MAX_LOOKUPS_PER_SCAN = 16_000;
export const AGENT_SOURCE_MAX_RESOLUTION_STEPS_PER_CANDIDATE = 4_096;

const CURRENT_AGENT_MODULE = "@sapiom/agent";
const LEGACY_AGENT_MODULE = "@sapiom/orchestration";
const CURRENT_FACTORY = "defineAgent";
const LEGACY_FACTORY = "defineOrchestration";
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isConfirmedMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameFileSnapshot(
  left: import("node:fs").Stats,
  right: import("node:fs").Stats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export interface AgentSourceScanLimits {
  maxModules: number;
  maxBytes: number;
  maxLookups: number;
}

interface AgentSourceDiscoveryOptions extends Partial<AgentSourceScanLimits> {
  maxResolutionSteps?: number;
  /** Test seam for proving scan-wide physical metadata work is memoized. */
  beforeModuleLookup?: (file: string) => Promise<void> | void;
  /** Test seam for deterministic file-mutation coverage. */
  beforeModuleRead?: (file: string) => Promise<void>;
  /** Test seam fired only after an opened inode matches admitted metadata. */
  onModuleBytesRead?: (file: string) => void;
  /** Test seam for proving syntax-resolution CPU work remains bounded. */
  onResolutionStep?: () => void;
}

/**
 * Logical scan-wide allowance. A cache hit still charges the first encounter,
 * while one canonical module shared by candidate graphs charges this workspace
 * scan once (and each candidate's separate budget once). Caching changes I/O
 * cost, never which rows or completeness an unchanged scan produces.
 */
export class AgentSourceScanBudget implements AgentSourceScanLimits {
  readonly maxModules: number;
  readonly maxBytes: number;
  readonly maxLookups: number;
  modules = 0;
  bytes = 0;
  lookups = 0;
  truncated = false;
  private readonly admittedModules = new Set<string>();
  private readonly admittedLookups = new Set<string>();
  private readonly moduleMetadata = new Map<string, Promise<ModuleMetadata>>();
  private readonly moduleContent = new Map<string, Promise<ModuleContent>>();

  constructor(limits: Partial<AgentSourceScanLimits> = {}) {
    this.maxModules = limits.maxModules ?? AGENT_SOURCE_MAX_MODULES_PER_SCAN;
    this.maxBytes = limits.maxBytes ?? AGENT_SOURCE_MAX_BYTES_PER_SCAN;
    this.maxLookups = limits.maxLookups ?? AGENT_SOURCE_MAX_LOOKUPS_PER_SCAN;
  }

  canAdmit(canonicalPath: string, size: number): boolean {
    if (this.admittedModules.has(canonicalPath)) return true;
    return this.modules < this.maxModules && this.bytes + size <= this.maxBytes;
  }

  admit(canonicalPath: string, size: number): boolean {
    if (this.admittedModules.has(canonicalPath)) return true;
    if (!this.canAdmit(canonicalPath, size)) {
      this.truncated = true;
      return false;
    }
    this.admittedModules.add(canonicalPath);
    this.modules += 1;
    this.bytes += size;
    return true;
  }

  admitLookup(key: string): boolean {
    if (this.admittedLookups.has(key)) return true;
    if (this.lookups >= this.maxLookups) {
      this.truncated = true;
      return false;
    }
    this.admittedLookups.add(key);
    this.lookups += 1;
    return true;
  }

  metadata(
    key: string,
    load: () => Promise<ModuleMetadata>,
  ): Promise<ModuleMetadata> {
    const existing = this.moduleMetadata.get(key);
    if (existing) return existing;
    const pending = load();
    this.moduleMetadata.set(key, pending);
    return pending;
  }

  content(
    key: string,
    load: () => Promise<ModuleContent>,
  ): Promise<ModuleContent> {
    const existing = this.moduleContent.get(key);
    if (existing) return existing;
    const pending = load();
    this.moduleContent.set(key, pending);
    return pending;
  }
}

interface CandidateBudget {
  readonly modules: Set<string>;
  bytes: number;
  lookups: number;
  truncated: boolean;
}

type ExpressionFact =
  | { kind: "identifier"; name: string }
  | { kind: "property"; target: ExpressionFact; name: string }
  | {
      kind: "call";
      callee: ExpressionFact;
      position: number;
      declaredName: string | null;
    }
  | { kind: "normal" }
  | { kind: "callable" }
  | { kind: "dynamic" };

type LocalBinding =
  | { kind: "expression"; expression: ExpressionFact }
  | {
      kind: "import";
      moduleSpecifier: string;
      importedName: string;
    }
  | { kind: "namespace"; moduleSpecifier: string }
  | { kind: "factory" };

type ExportBinding =
  | { kind: "local"; localName: string }
  | { kind: "expression"; expression: ExpressionFact }
  | {
      kind: "reexport";
      moduleSpecifier: string;
      importedName: string;
    };

interface ParsedModule {
  readonly bindings: ReadonlyMap<string, LocalBinding>;
  readonly exports: ReadonlyMap<string, readonly ExportBinding[]>;
  readonly exportStars: readonly string[];
  readonly parseable: boolean;
  readonly unresolved: boolean;
}

type ModuleMetadata =
  | {
      status: "missing" | "not-file" | "symlink" | "incomplete";
      fingerprint: string;
    }
  | {
      status: "file";
      lexicalPath: string;
      canonicalPath: string;
      stat: import("node:fs").Stats;
      fingerprint: string;
    };

type ModuleContent =
  | { status: "loaded"; parsed: ParsedModule }
  | { status: "incomplete"; fingerprint: string };

interface CacheEntry {
  readonly canonicalPath: string;
  readonly parsed: ParsedModule;
  readonly dev: number;
  readonly ino: number;
}

/** LRU of compact syntax facts, keyed exactly by canonical path + size + mtime. */
export class AgentSourceModuleCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly keyByPath = new Map<string, string>();

  constructor(
    private readonly maxEntries = AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.keyByPath.clear();
  }

  get(
    canonicalPath: string,
    size: number,
    mtimeMs: number,
    dev: number,
    ino: number,
  ): ParsedModule | null {
    const key = moduleCacheKey(canonicalPath, size, mtimeMs);
    const entry = this.entries.get(key);
    if (!entry || entry.dev !== dev || entry.ino !== ino) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.parsed;
  }

  set(
    canonicalPath: string,
    size: number,
    mtimeMs: number,
    dev: number,
    ino: number,
    parsed: ParsedModule,
  ): void {
    if (this.maxEntries <= 0) return;
    const key = moduleCacheKey(canonicalPath, size, mtimeMs);
    const previousKey = this.keyByPath.get(canonicalPath);
    if (previousKey && previousKey !== key) this.entries.delete(previousKey);
    this.entries.delete(key);
    this.entries.set(key, { canonicalPath, parsed, dev, ino });
    this.keyByPath.set(canonicalPath, key);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest && this.keyByPath.get(oldest.canonicalPath) === oldestKey) {
        this.keyByPath.delete(oldest.canonicalPath);
      }
    }
  }
}

function moduleCacheKey(
  canonicalPath: string,
  size: number,
  mtimeMs: number,
): string {
  return `${canonicalPath}\0${size}\0${mtimeMs}`;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return expression.text;
    }
  }
  return null;
}

function declaredAgentName(call: ts.CallExpression): string | null {
  const argument = call.arguments[0];
  if (!argument) return null;
  const unwrapped = unwrapExpression(argument);
  if (!ts.isObjectLiteralExpression(unwrapped)) return null;

  let name: string | null = null;
  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) {
      name = null;
      continue;
    }
    if (!property.name) continue;
    const staticPropertyName = propertyName(property.name);
    if (
      ts.isComputedPropertyName(property.name) &&
      staticPropertyName === null
    ) {
      name = null;
      continue;
    }
    if (staticPropertyName !== "name") continue;
    if (!ts.isPropertyAssignment(property)) {
      name = null;
      continue;
    }
    const value = unwrapExpression(property.initializer);
    name =
      ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
        ? value.text.trim() || null
        : null;
  }
  return name;
}

function expressionFact(expression: ts.Expression): ExpressionFact {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return { kind: "identifier", name: current.text };
  }
  if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.name)) {
    return {
      kind: "property",
      target: expressionFact(current.expression),
      name: current.name.text,
    };
  }
  if (ts.isElementAccessExpression(current)) {
    const argument = current.argumentExpression
      ? unwrapExpression(current.argumentExpression)
      : null;
    if (
      argument &&
      (ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      return {
        kind: "property",
        target: expressionFact(current.expression),
        name: argument.text,
      };
    }
  }
  if (ts.isCallExpression(current)) {
    return {
      kind: "call",
      callee: expressionFact(current.expression),
      position: current.getStart(),
      declaredName: declaredAgentName(current),
    };
  }
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    ts.isNumericLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword ||
    ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current) ||
    ts.isClassExpression(current)
  ) {
    return { kind: "normal" };
  }
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    return { kind: "callable" };
  }
  return { kind: "dynamic" };
}

function bindingName(name: ts.BindingName): string | null {
  return ts.isIdentifier(name) ? name.text : null;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

function exportName(name: ts.ModuleExportName): string {
  return name.text;
}

function collectWrittenTarget(node: ts.Node, names: Set<string>): void {
  const current = ts.isExpression(node) ? unwrapExpression(node) : node;
  if (ts.isIdentifier(current)) {
    names.add(current.text);
    return;
  }
  if (ts.isPropertyAccessExpression(current)) {
    collectWrittenTarget(current.expression, names);
    return;
  }
  if (ts.isElementAccessExpression(current)) {
    collectWrittenTarget(current.expression, names);
    return;
  }
  if (ts.isSpreadElement(current)) {
    collectWrittenTarget(current.expression, names);
    return;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    current.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    collectWrittenTarget(current.left, names);
    return;
  }
  if (ts.isObjectLiteralExpression(current)) {
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        names.add(property.name.text);
      } else if (ts.isPropertyAssignment(property)) {
        collectWrittenTarget(property.initializer, names);
      } else if (ts.isSpreadAssignment(property)) {
        collectWrittenTarget(property.expression, names);
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(current)) {
    for (const element of current.elements) {
      if (!ts.isOmittedExpression(element))
        collectWrittenTarget(element, names);
    }
  }
}

function collectWrittenExpression(
  expression: ts.Expression,
  names: Set<string>,
): void {
  const current = unwrapExpression(expression);
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    current.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    collectWrittenTarget(current.left, names);
    return;
  }
  if (
    (ts.isPrefixUnaryExpression(current) ||
      ts.isPostfixUnaryExpression(current)) &&
    (current.operator === ts.SyntaxKind.PlusPlusToken ||
      current.operator === ts.SyntaxKind.MinusMinusToken) &&
    ts.isExpression(current.operand)
  ) {
    collectWrittenTarget(current.operand, names);
  }
}

function collectTopLevelWrites(node: ts.Node, names: Set<string>): void {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return;
  }
  if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)
  ) {
    collectWrittenTarget(node.initializer, names);
  }
  if (ts.isExpression(node)) {
    collectWrittenExpression(node, names);
  }
  node.forEachChild((child) => collectTopLevelWrites(child, names));
}

function isCommonJsExportReference(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text === "exports";
  if (ts.isPropertyAccessExpression(current)) {
    if (
      ts.isIdentifier(current.expression) &&
      current.expression.text === "module" &&
      current.name.text === "exports"
    ) {
      return true;
    }
    return isCommonJsExportReference(current.expression);
  }
  if (ts.isElementAccessExpression(current)) {
    if (
      ts.isIdentifier(current.expression) &&
      current.expression.text === "module" &&
      current.argumentExpression &&
      ts.isStringLiteralLike(current.argumentExpression) &&
      current.argumentExpression.text === "exports"
    ) {
      return true;
    }
    return isCommonJsExportReference(current.expression);
  }
  return false;
}

function containsUnsupportedCommonJsExport(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    // This parser proves ESM exports only. A CommonJS reference anywhere in
    // the module can become observable through a later top-level call/new or
    // decorator, and proving that call graph without executing project code is
    // outside this bounded resolver. Conservatively reject even dormant
    // function/class bodies rather than falsely accepting a mixed module.
    if (ts.isExpression(current) && isCommonJsExportReference(current)) {
      found = true;
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

function pushExport(
  exports: Map<string, ExportBinding[]>,
  name: string,
  binding: ExportBinding,
): boolean {
  const current = exports.get(name) ?? [];
  if (current.length > 0) return false;
  current.push(binding);
  exports.set(name, current);
  return true;
}

function officialFactory(
  moduleSpecifier: string,
  importedName: string,
): boolean {
  return (
    (moduleSpecifier === CURRENT_AGENT_MODULE &&
      importedName === CURRENT_FACTORY) ||
    (moduleSpecifier === LEGACY_AGENT_MODULE && importedName === LEGACY_FACTORY)
  );
}

function parseModule(file: string, content: string): ParsedModule {
  const sourceFile = ts.createSourceFile(
    path.basename(file),
    content,
    ts.ScriptTarget.Latest,
    true,
    path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    return {
      bindings: new Map(),
      exports: new Map(),
      exportStars: [],
      parseable: false,
      unresolved: true,
    };
  }

  const bindings = new Map<string, LocalBinding>();
  const exports = new Map<string, ExportBinding[]>();
  const exportStars: string[] = [];
  const writtenNames = new Set<string>();
  const validFunctionOverloads = new Set<string>();
  const handledFunctionOverloads = new Set<string>();
  let unresolved = false;

  const functionGroups = new Map<string, ts.FunctionDeclaration[]>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    const group = functionGroups.get(statement.name.text) ?? [];
    group.push(statement);
    functionGroups.set(statement.name.text, group);
  }
  for (const [name, group] of functionGroups) {
    const modifierShape = group.map(
      (declaration) =>
        `${hasExportModifier(declaration)}:${hasDefaultModifier(declaration)}`,
    );
    if (
      group.length > 1 &&
      group.filter((declaration) => declaration.body).length === 1 &&
      modifierShape.every((shape) => shape === modifierShape[0])
    ) {
      validFunctionOverloads.add(name);
    }
  }

  const setBinding = (name: string, binding: LocalBinding): void => {
    if (bindings.has(name)) {
      bindings.set(name, {
        kind: "expression",
        expression: { kind: "dynamic" },
      });
      return;
    }
    bindings.set(name, binding);
  };

  for (const statement of sourceFile.statements) {
    collectTopLevelWrites(statement, writtenNames);

    // This resolver proves ESM exports only. CommonJS/import-equals structures
    // can add or replace the public export surface, so ignoring them would turn
    // an unresolved module into a definitive not-agent (or one-agent) result.
    if (
      ts.isImportEqualsDeclaration(statement) ||
      containsUnsupportedCommonJsExport(statement)
    ) {
      unresolved = true;
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const moduleSpecifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) {
        setBinding(clause.name.text, {
          kind: "import",
          moduleSpecifier,
          importedName: "default",
        });
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        setBinding(named.name.text, { kind: "namespace", moduleSpecifier });
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          setBinding(
            element.name.text,
            officialFactory(moduleSpecifier, importedName)
              ? { kind: "factory" }
              : { kind: "import", moduleSpecifier, importedName },
          );
        }
      }
      continue;
    }

    if (
      (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
      ts.isIdentifier(statement.name)
    ) {
      setBinding(statement.name.text, {
        kind: "expression",
        expression: { kind: "normal" },
      });
      if (hasExportModifier(statement)) {
        unresolved ||= !pushExport(exports, statement.name.text, {
          kind: "local",
          localName: statement.name.text,
        });
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const immutable = Boolean(
        statement.declarationList.flags & ts.NodeFlags.Const,
      );
      for (const declaration of statement.declarationList.declarations) {
        const directName = bindingName(declaration.name);
        const names = bindingNames(declaration.name);
        if (names.length === 0) unresolved = true;
        for (const name of names) {
          setBinding(name, {
            kind: "expression",
            expression:
              directName === name && immutable && declaration.initializer
                ? expressionFact(declaration.initializer)
                : { kind: "dynamic" },
          });
          if (hasExportModifier(statement)) {
            unresolved ||= !pushExport(exports, name, {
              kind: "local",
              localName: name,
            });
          }
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement)
    ) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        validFunctionOverloads.has(statement.name.text)
      ) {
        if (handledFunctionOverloads.has(statement.name.text)) continue;
        handledFunctionOverloads.add(statement.name.text);
      }
      if (statement.name) {
        setBinding(statement.name.text, {
          kind: "expression",
          expression: {
            kind: ts.isFunctionDeclaration(statement) ? "callable" : "normal",
          },
        });
      }
      if (hasExportModifier(statement)) {
        const exportedName = hasDefaultModifier(statement)
          ? "default"
          : statement.name?.text;
        if (exportedName) {
          unresolved ||= !pushExport(
            exports,
            exportedName,
            statement.name
              ? { kind: "local", localName: statement.name.text }
              : {
                  kind: "expression",
                  expression: {
                    kind: ts.isFunctionDeclaration(statement)
                      ? "callable"
                      : "normal",
                  },
                },
          );
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) {
        unresolved ||= !pushExport(exports, "default", {
          kind: "expression",
          expression: expressionFact(statement.expression),
        });
      } else {
        unresolved = true;
      }
      continue;
    }

    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
    if (!statement.exportClause) {
      if (moduleSpecifier) exportStars.push(moduleSpecifier);
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) {
      unresolved = true;
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const exportedName = exportName(element.name);
      const importedName = element.propertyName
        ? exportName(element.propertyName)
        : exportedName;
      if (moduleSpecifier) {
        unresolved ||= !pushExport(exports, exportedName, {
          kind: "reexport",
          moduleSpecifier,
          importedName,
        });
      } else {
        unresolved ||= !pushExport(exports, exportedName, {
          kind: "local",
          localName: importedName,
        });
      }
    }
  }

  for (const name of writtenNames) {
    if (bindings.has(name)) {
      bindings.set(name, {
        kind: "expression",
        expression: { kind: "dynamic" },
      });
    }
  }

  return {
    bindings,
    exports,
    exportStars: [...new Set(exportStars)].sort(compareText),
    parseable: true,
    unresolved,
  };
}

interface AgentProof {
  readonly id: string;
  readonly name: string | null;
}

interface ResolvedValue {
  readonly factory: boolean;
  readonly namespaces: readonly string[];
  readonly agents: ReadonlyMap<string, AgentProof>;
  readonly incomplete: boolean;
  readonly unresolvedExternal: boolean;
  readonly callable: boolean;
}

const EMPTY_VALUE: ResolvedValue = {
  factory: false,
  namespaces: [],
  agents: new Map(),
  incomplete: false,
  unresolvedExternal: false,
  callable: false,
};

function incompleteValue(): ResolvedValue {
  return { ...EMPTY_VALUE, incomplete: true };
}

function mergeValues(values: readonly ResolvedValue[]): ResolvedValue {
  const agents = new Map<string, AgentProof>();
  const namespaces = new Set<string>();
  let factory = false;
  let incomplete = false;
  let unresolvedExternal = false;
  let callable = false;
  for (const value of values) {
    factory ||= value.factory;
    incomplete ||= value.incomplete;
    unresolvedExternal ||= value.unresolvedExternal;
    callable ||= value.callable;
    for (const namespace of value.namespaces) namespaces.add(namespace);
    for (const [id, agent] of value.agents) agents.set(id, agent);
  }
  return {
    factory,
    namespaces: [...namespaces].sort(compareText),
    agents,
    incomplete,
    unresolvedExternal,
    callable,
  };
}

function equivalentResolvedBinding(
  values: readonly ResolvedValue[],
): ResolvedValue | null {
  if (
    values.length === 0 ||
    values.some((value) => value.incomplete || value.unresolvedExternal)
  ) {
    return null;
  }
  const signature = (value: ResolvedValue): string =>
    JSON.stringify({
      factory: value.factory,
      namespaces: [...value.namespaces].sort(compareText),
      agents: [...value.agents.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([id, proof]) => [id, proof.name]),
      callable: value.callable,
    });
  const first = values[0] as ResolvedValue;
  const expected = signature(first);
  return values.every((value) => signature(value) === expected) ? first : null;
}

interface LoadedModule {
  readonly file: string;
  readonly parsed: ParsedModule;
}

interface ResolverState {
  readonly workspaceRoot: string;
  readonly canonicalWorkspaceRoot: string;
  readonly admittedDirectory: Map<
    string,
    { admitted: boolean; stat?: import("node:fs").Stats }
  >;
  readonly scanBudget: AgentSourceScanBudget;
  readonly candidateBudget: CandidateBudget;
  readonly loaded: Map<string, LoadedModule>;
  readonly exactLoads: Map<string, Promise<LoadResult>>;
  readonly observedFingerprints: Set<string>;
  resolutionSteps: number;
}

async function isAdmittedModulePath(
  file: string,
  state: ResolverState,
): Promise<boolean> {
  const relativeDirectory = path.relative(
    state.workspaceRoot,
    path.dirname(file),
  );
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    return false;
  }
  let directory = state.workspaceRoot;
  const segments = relativeDirectory.split(path.sep).filter(Boolean);
  for (const segment of ["", ...segments]) {
    if (segment) directory = path.join(directory, segment);
    if (isAgentProjectScanIgnoredDir(segment)) return false;
    const cached = state.admittedDirectory.get(directory);
    if (cached !== undefined) {
      if (!cached.admitted || !cached.stat) return false;
      try {
        const current = await fs.lstat(directory);
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          !sameFileSnapshot(current, cached.stat)
        ) {
          state.admittedDirectory.set(directory, { admitted: false });
          return false;
        }
        if (directory !== state.workspaceRoot) {
          try {
            await fs.lstat(path.join(directory, ".git"));
            state.admittedDirectory.set(directory, { admitted: false });
            return false;
          } catch (error) {
            if (!isConfirmedMissing(error)) return false;
          }
        }
        continue;
      } catch {
        state.admittedDirectory.set(directory, { admitted: false });
        return false;
      }
    }
    try {
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        state.admittedDirectory.set(directory, { admitted: false });
        return false;
      }
      if (directory !== state.workspaceRoot) {
        try {
          await fs.lstat(path.join(directory, ".git"));
          state.admittedDirectory.set(directory, { admitted: false });
          return false;
        } catch (error) {
          if (!isConfirmedMissing(error)) {
            state.admittedDirectory.set(directory, { admitted: false });
            return false;
          }
        }
      }
      state.admittedDirectory.set(directory, {
        admitted: true,
        stat: directoryStat,
      });
    } catch (error) {
      state.admittedDirectory.set(directory, { admitted: false });
      return false;
    }
  }
  return true;
}

type LoadResult =
  | { status: "loaded"; module: LoadedModule }
  | { status: "missing" }
  | { status: "not-file" }
  | { status: "symlink" }
  | { status: "incomplete" };

function relativeModuleCandidates(
  importer: string,
  moduleSpecifier: string,
): string[] {
  const base = path.resolve(path.dirname(importer), moduleSpecifier);
  const extension = path.extname(base);
  if (
    TYPESCRIPT_EXTENSIONS.includes(
      extension as (typeof TYPESCRIPT_EXTENSIONS)[number],
    )
  ) {
    return [base];
  }
  const sourceBase = base.slice(0, -extension.length);
  if (extension === ".jsx") return [`${sourceBase}.tsx`];
  if (extension === ".mjs") return [`${sourceBase}.mts`];
  if (extension === ".cjs") return [`${sourceBase}.cts`];
  if (extension === ".js") {
    return [`${sourceBase}.ts`, `${sourceBase}.tsx`];
  }
  if (extension !== "") return [];
  return [
    ...TYPESCRIPT_EXTENSIONS.map(
      (candidateExtension) => `${base}${candidateExtension}`,
    ),
    ...TYPESCRIPT_EXTENSIONS.map((candidateExtension) =>
      path.join(base, `index${candidateExtension}`),
    ),
  ];
}

function isRelativeModuleSpecifier(moduleSpecifier: string): boolean {
  return (
    moduleSpecifier === "." ||
    moduleSpecifier === ".." ||
    moduleSpecifier.startsWith("./") ||
    moduleSpecifier.startsWith("../")
  );
}

export type AgentSourceDiscoveryResult =
  | {
      status: "absent" | "not-agent";
      fingerprint: string;
      observations: readonly string[];
      watchPaths: readonly string[];
      modules: number;
      bytes: number;
      lookups: number;
    }
  | {
      status: "agent";
      name: string | null;
      fingerprint: string;
      observations: readonly string[];
      watchPaths: readonly string[];
      modules: number;
      bytes: number;
      lookups: number;
    }
  | {
      status: "incomplete";
      reason:
        | "ambiguous-export"
        | "budget"
        | "invalid-source"
        | "unreadable-source"
        | "unresolved-export";
      fingerprint: string;
      observations: readonly string[];
      watchPaths: readonly string[];
      modules: number;
      bytes: number;
      lookups: number;
    };

export class AgentSourceDiscovery {
  constructor(
    private readonly cache = new AgentSourceModuleCache(),
    private readonly options: AgentSourceDiscoveryOptions = {},
  ) {}

  async inspectCandidate(
    candidateRoot: string,
    scanBudget: AgentSourceScanBudget = new AgentSourceScanBudget(),
    workspaceRoot: string = candidateRoot,
  ): Promise<AgentSourceDiscoveryResult> {
    const absoluteRoot = path.resolve(candidateRoot);
    const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
    let canonicalCandidateRoot: string;
    let canonicalWorkspaceRoot: string;
    try {
      canonicalCandidateRoot = await fs.realpath(absoluteRoot);
      canonicalWorkspaceRoot = await fs.realpath(absoluteWorkspaceRoot);
    } catch (error) {
      return discoveryResult(
        "incomplete",
        new Set([`${absoluteRoot}\0<unreadable>`]),
        { modules: new Set(), bytes: 0, lookups: 0, truncated: false },
        isConfirmedMissing(error) ? "unresolved-export" : "unreadable-source",
      );
    }
    if (
      !isWithin(absoluteWorkspaceRoot, absoluteRoot) ||
      !isWithin(canonicalWorkspaceRoot, canonicalCandidateRoot)
    ) {
      return discoveryResult(
        "incomplete",
        new Set([`${absoluteRoot}\0<outside-workspace>`]),
        { modules: new Set(), bytes: 0, lookups: 0, truncated: false },
        "unresolved-export",
      );
    }
    const state: ResolverState = {
      workspaceRoot: canonicalWorkspaceRoot,
      canonicalWorkspaceRoot,
      admittedDirectory: new Map(),
      scanBudget,
      candidateBudget: {
        modules: new Set(),
        bytes: 0,
        lookups: 0,
        truncated: false,
      },
      loaded: new Map(),
      exactLoads: new Map(),
      observedFingerprints: new Set(),
      resolutionSteps: 0,
    };
    const entryPath = path.join(
      canonicalCandidateRoot,
      AGENT_SOURCE_ENTRYPOINT,
    );
    const entry = await this.loadExactModule(entryPath, state);
    if (entry.status === "missing") {
      state.observedFingerprints.add(`${entryPath}\0<absent>`);
      return discoveryResult(
        "absent",
        state.observedFingerprints,
        state.candidateBudget,
      );
    }
    if (entry.status === "not-file" || entry.status === "symlink") {
      return discoveryResult(
        "absent",
        state.observedFingerprints,
        state.candidateBudget,
      );
    }
    if (entry.status === "incomplete") {
      return discoveryResult(
        "incomplete",
        state.observedFingerprints,
        state.candidateBudget,
        scanBudget.truncated || state.candidateBudget.truncated
          ? "budget"
          : "unreadable-source",
      );
    }
    if (!entry.module.parsed.parseable) {
      return discoveryResult(
        "incomplete",
        state.observedFingerprints,
        state.candidateBudget,
        "invalid-source",
      );
    }
    if (entry.module.parsed.unresolved) {
      return discoveryResult(
        "incomplete",
        state.observedFingerprints,
        state.candidateBudget,
        "unresolved-export",
      );
    }

    const value = await this.resolveAllExports(
      entry.module,
      0,
      state,
      new Set(),
      true,
    );
    if (value.incomplete || value.unresolvedExternal) {
      return discoveryResult(
        "incomplete",
        state.observedFingerprints,
        state.candidateBudget,
        scanBudget.truncated || state.candidateBudget.truncated
          ? "budget"
          : "unresolved-export",
      );
    }
    if (value.agents.size === 0) {
      return discoveryResult(
        "not-agent",
        state.observedFingerprints,
        state.candidateBudget,
      );
    }
    if (value.agents.size !== 1) {
      return discoveryResult(
        "incomplete",
        state.observedFingerprints,
        state.candidateBudget,
        "ambiguous-export",
      );
    }
    const proof = value.agents.values().next().value as AgentProof;
    return discoveryResult(
      "agent",
      state.observedFingerprints,
      state.candidateBudget,
      proof.name,
    );
  }

  private async loadExactModule(
    file: string,
    state: ResolverState,
  ): Promise<LoadResult> {
    const lexicalPath = path.resolve(file);
    const lookupKey = `${state.workspaceRoot}\0${lexicalPath}`;
    const existing = state.exactLoads.get(lookupKey);
    if (existing) return existing;
    const maxLookups =
      this.options.maxLookups ?? AGENT_SOURCE_MAX_LOOKUPS_PER_CANDIDATE;
    if (state.candidateBudget.lookups >= maxLookups) {
      state.candidateBudget.truncated = true;
      return { status: "incomplete" };
    }
    if (!state.scanBudget.admitLookup(lookupKey)) {
      return { status: "incomplete" };
    }
    state.candidateBudget.lookups += 1;
    const pending = this.loadExactModuleUnmemoized(lexicalPath, state);
    state.exactLoads.set(lookupKey, pending);
    return pending;
  }

  private async loadExactModuleUnmemoized(
    file: string,
    state: ResolverState,
  ): Promise<LoadResult> {
    const lexicalPath = path.resolve(file);
    const lookupKey = `${state.workspaceRoot}\0${lexicalPath}`;
    const metadata = await state.scanBudget.metadata(lookupKey, () =>
      this.readModuleMetadata(lexicalPath, state),
    );
    state.observedFingerprints.add(metadata.fingerprint);
    if (metadata.status !== "file") return { status: metadata.status };

    const { canonicalPath, stat } = metadata;
    const alreadyLoaded = state.loaded.get(canonicalPath);
    if (alreadyLoaded) return { status: "loaded", module: alreadyLoaded };

    const isNewCandidateModule =
      !state.candidateBudget.modules.has(canonicalPath);
    const nextModuleCount =
      state.candidateBudget.modules.size + (isNewCandidateModule ? 1 : 0);
    const nextCandidateBytes =
      state.candidateBudget.bytes + (isNewCandidateModule ? stat.size : 0);
    const maxModules =
      this.options.maxModules ?? AGENT_SOURCE_MAX_MODULES_PER_CANDIDATE;
    const maxBytes =
      this.options.maxBytes ?? AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE;
    if (
      nextModuleCount > maxModules ||
      nextCandidateBytes > maxBytes ||
      !state.scanBudget.canAdmit(canonicalPath, stat.size)
    ) {
      state.candidateBudget.truncated ||=
        nextModuleCount > maxModules || nextCandidateBytes > maxBytes;
      state.scanBudget.truncated ||= !state.scanBudget.canAdmit(
        canonicalPath,
        stat.size,
      );
      return { status: "incomplete" };
    }

    if (isNewCandidateModule) {
      state.candidateBudget.modules.add(canonicalPath);
      state.candidateBudget.bytes = nextCandidateBytes;
    }
    state.scanBudget.admit(canonicalPath, stat.size);

    const contentKey = [
      canonicalPath,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
    ].join("\0");
    const content = await state.scanBudget.content(contentKey, () =>
      this.readModuleContent(metadata, state),
    );
    if (content.status === "incomplete") {
      state.observedFingerprints.add(content.fingerprint);
      return { status: "incomplete" };
    }
    const loaded = { file: canonicalPath, parsed: content.parsed };
    state.loaded.set(canonicalPath, loaded);
    return { status: "loaded", module: loaded };
  }

  private async readModuleMetadata(
    lexicalPath: string,
    state: ResolverState,
  ): Promise<ModuleMetadata> {
    try {
      await this.options.beforeModuleLookup?.(lexicalPath);
    } catch {
      return {
        status: "incomplete",
        fingerprint: `${lexicalPath}\0<lookup-hook-failed>`,
      };
    }
    if (!isWithin(state.workspaceRoot, lexicalPath)) {
      return {
        status: "incomplete",
        fingerprint: `${lexicalPath}\0<outside-workspace>`,
      };
    }
    if (!(await isAdmittedModulePath(lexicalPath, state))) {
      return {
        status: "incomplete",
        fingerprint: `${lexicalPath}\0<inadmissible-path>`,
      };
    }
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(lexicalPath);
    } catch (error) {
      return {
        status: isConfirmedMissing(error) ? "missing" : "incomplete",
        fingerprint: `${lexicalPath}\0${
          isConfirmedMissing(error) ? "<absent>" : "<unreadable>"
        }`,
      };
    }
    if (stat.isSymbolicLink()) {
      return {
        status: "symlink",
        fingerprint: `${lexicalPath}\0<symlink>`,
      };
    }
    if (!stat.isFile()) {
      return {
        status: "not-file",
        fingerprint: `${lexicalPath}\0<not-file>`,
      };
    }
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(lexicalPath);
    } catch {
      return {
        status: "incomplete",
        fingerprint: `${lexicalPath}\0<unreadable-realpath>`,
      };
    }
    if (!isWithin(state.canonicalWorkspaceRoot, canonicalPath)) {
      return {
        status: "incomplete",
        fingerprint: `${lexicalPath}\0<outside-canonical-workspace>`,
      };
    }
    return {
      status: "file",
      lexicalPath,
      canonicalPath,
      stat,
      fingerprint: `${lexicalPath}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`,
    };
  }

  private async readModuleContent(
    metadata: Extract<ModuleMetadata, { status: "file" }>,
    state: ResolverState,
  ): Promise<ModuleContent> {
    const { canonicalPath, lexicalPath, stat } = metadata;
    try {
      await this.options.beforeModuleRead?.(canonicalPath);
    } catch {
      return {
        status: "incomplete",
        fingerprint: `${lexicalPath}\0<read-hook-failed>`,
      };
    }
    let parsed = this.cache.get(
      canonicalPath,
      stat.size,
      stat.mtimeMs,
      stat.dev,
      stat.ino,
    );
    if (parsed) {
      try {
        if (!(await isAdmittedModulePath(lexicalPath, state))) {
          throw new Error("module ancestors changed");
        }
        const verifiedStat = await fs.lstat(lexicalPath);
        const verifiedCanonicalPath = await fs.realpath(lexicalPath);
        if (
          verifiedStat.isSymbolicLink() ||
          !verifiedStat.isFile() ||
          !sameFileSnapshot(verifiedStat, stat) ||
          verifiedCanonicalPath !== canonicalPath
        ) {
          return {
            status: "incomplete",
            fingerprint: `${lexicalPath}\0<changed-before-cache>`,
          };
        }
      } catch {
        return {
          status: "incomplete",
          fingerprint: `${lexicalPath}\0<changed-before-cache>`,
        };
      }
    } else {
      try {
        const handle = await fs.open(
          canonicalPath,
          fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
        );
        try {
          const openedStat = await handle.stat();
          const admitted = await isAdmittedModulePath(lexicalPath, state);
          const beforeReadPathStat = await fs.lstat(lexicalPath);
          const beforeReadCanonicalPath = await fs.realpath(lexicalPath);
          if (
            !openedStat.isFile() ||
            !sameFileSnapshot(openedStat, stat) ||
            !admitted ||
            beforeReadPathStat.isSymbolicLink() ||
            !beforeReadPathStat.isFile() ||
            !sameFileSnapshot(beforeReadPathStat, stat) ||
            beforeReadCanonicalPath !== canonicalPath
          ) {
            return {
              status: "incomplete",
              fingerprint: `${lexicalPath}\0<changed-before-read>`,
            };
          }
          const bytes = Buffer.alloc(stat.size + 1);
          this.options.onModuleBytesRead?.(canonicalPath);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(
              bytes,
              offset,
              bytes.length - offset,
              offset,
            );
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          const finalHandleStat = await handle.stat();
          const finalPathStat = await fs.lstat(lexicalPath);
          const finalCanonicalPath = await fs.realpath(lexicalPath);
          const finalAdmission = await isAdmittedModulePath(lexicalPath, state);
          const stable =
            openedStat.isFile() &&
            !finalPathStat.isSymbolicLink() &&
            finalPathStat.isFile() &&
            sameFileSnapshot(openedStat, stat) &&
            sameFileSnapshot(finalHandleStat, stat) &&
            sameFileSnapshot(finalPathStat, stat) &&
            finalCanonicalPath === canonicalPath &&
            finalAdmission &&
            offset === stat.size;
          if (!stable) {
            return {
              status: "incomplete",
              fingerprint: `${lexicalPath}\0<changed-during-read>`,
            };
          }
          parsed = parseModule(
            canonicalPath,
            bytes.subarray(0, offset).toString("utf8"),
          );
        } finally {
          await handle.close();
        }
      } catch {
        return {
          status: "incomplete",
          fingerprint: `${lexicalPath}\0<unreadable-content>`,
        };
      }
      this.cache.set(
        canonicalPath,
        stat.size,
        stat.mtimeMs,
        stat.dev,
        stat.ino,
        parsed,
      );
    }
    return { status: "loaded", parsed };
  }

  private async loadRelativeModule(
    importer: string,
    moduleSpecifier: string,
    depth: number,
    state: ResolverState,
  ): Promise<LoadResult> {
    if (!isRelativeModuleSpecifier(moduleSpecifier)) {
      return { status: "missing" };
    }
    if (depth > AGENT_SOURCE_MAX_IMPORT_DEPTH) {
      return { status: "incomplete" };
    }
    for (const candidate of relativeModuleCandidates(
      importer,
      moduleSpecifier,
    )) {
      const result = await this.loadExactModule(candidate, state);
      if (
        result.status === "loaded" ||
        result.status === "symlink" ||
        result.status === "incomplete"
      ) {
        return result;
      }
    }
    return { status: "incomplete" };
  }

  private admitResolutionStep(state: ResolverState): boolean {
    const maxSteps =
      this.options.maxResolutionSteps ??
      AGENT_SOURCE_MAX_RESOLUTION_STEPS_PER_CANDIDATE;
    if (state.resolutionSteps >= maxSteps) {
      state.candidateBudget.truncated = true;
      return false;
    }
    state.resolutionSteps += 1;
    this.options.onResolutionStep?.();
    return true;
  }

  private async collectExportedNames(
    module: LoadedModule,
    depth: number,
    state: ResolverState,
    stack: Set<string>,
  ): Promise<{ names: Set<string>; incomplete: boolean }> {
    if (!this.admitResolutionStep(state)) {
      return { names: new Set(), incomplete: true };
    }
    const stackKey = `${module.file}\0export-names`;
    if (stack.has(stackKey)) return { names: new Set(), incomplete: false };
    if (!module.parsed.parseable || module.parsed.unresolved) {
      return { names: new Set(), incomplete: true };
    }
    const nextStack = new Set(stack).add(stackKey);
    const explicitNames = new Set(module.parsed.exports.keys());
    const names = new Set(explicitNames);
    const starNameOwners = new Map<string, string>();
    let incomplete = false;
    for (const moduleSpecifier of module.parsed.exportStars) {
      if (!isRelativeModuleSpecifier(moduleSpecifier)) {
        incomplete = true;
        continue;
      }
      const loaded = await this.loadRelativeModule(
        module.file,
        moduleSpecifier,
        depth + 1,
        state,
      );
      if (loaded.status !== "loaded") {
        incomplete = true;
        continue;
      }
      const child = await this.collectExportedNames(
        loaded.module,
        depth + 1,
        state,
        nextStack,
      );
      incomplete ||= child.incomplete;
      for (const name of child.names) {
        if (name === "default" || explicitNames.has(name)) continue;
        const previousOwner = starNameOwners.get(name);
        if (previousOwner && previousOwner !== loaded.module.file) {
          incomplete = true;
          names.delete(name);
          continue;
        }
        if (!previousOwner) {
          starNameOwners.set(name, loaded.module.file);
          names.add(name);
        }
      }
    }
    return { names, incomplete };
  }

  private async resolveAllExports(
    module: LoadedModule,
    depth: number,
    state: ResolverState,
    stack: Set<string>,
    includeDefault: boolean,
    excludedNames: ReadonlySet<string> = new Set(),
  ): Promise<ResolvedValue> {
    if (!this.admitResolutionStep(state)) return incompleteValue();
    if (module.parsed.unresolved) return incompleteValue();
    const stackKey = `${module.file}\0*\0${includeDefault ? "all" : "named"}`;
    if (stack.has(stackKey)) return EMPTY_VALUE;
    const nextStack = new Set(stack).add(stackKey);
    const values: ResolvedValue[] = [];
    for (const [name] of [...module.parsed.exports.entries()].sort(
      ([left], [right]) => compareText(left, right),
    )) {
      if (excludedNames.has(name)) continue;
      if (!includeDefault && name === "default") continue;
      values.push(
        await this.resolveExport(module, name, depth, state, nextStack),
      );
    }
    const shadowedNames = new Set(excludedNames);
    shadowedNames.add("default");
    for (const name of module.parsed.exports.keys()) shadowedNames.add(name);
    const starOwners = new Map<string, LoadedModule[]>();
    for (const moduleSpecifier of module.parsed.exportStars) {
      if (!isRelativeModuleSpecifier(moduleSpecifier)) {
        values.push(incompleteValue());
        continue;
      }
      const loaded = await this.loadRelativeModule(
        module.file,
        moduleSpecifier,
        depth + 1,
        state,
      );
      if (loaded.status !== "loaded") {
        values.push(incompleteValue());
        continue;
      }
      if (!loaded.module.parsed.parseable) {
        values.push(incompleteValue());
        continue;
      }
      const exportedNames = await this.collectExportedNames(
        loaded.module,
        depth + 1,
        state,
        nextStack,
      );
      if (exportedNames.incomplete) values.push(incompleteValue());
      for (const name of exportedNames.names) {
        if (shadowedNames.has(name)) continue;
        const owners = starOwners.get(name) ?? [];
        owners.push(loaded.module);
        starOwners.set(name, owners);
      }
    }
    for (const [name, owners] of [...starOwners.entries()].sort(
      ([left], [right]) => compareText(left, right),
    )) {
      const distinctOwners = new Map(
        owners.map((owner) => [owner.file, owner]),
      );
      const resolvedOwners: ResolvedValue[] = [];
      for (const owner of distinctOwners.values()) {
        resolvedOwners.push(
          await this.resolveExport(owner, name, depth + 1, state, nextStack),
        );
      }
      const resolved = equivalentResolvedBinding(resolvedOwners);
      values.push(resolved ?? incompleteValue());
    }
    return mergeValues(values);
  }

  private async resolveExport(
    module: LoadedModule,
    exportName: string,
    depth: number,
    state: ResolverState,
    stack: Set<string>,
  ): Promise<ResolvedValue> {
    if (!this.admitResolutionStep(state)) return incompleteValue();
    if (module.parsed.unresolved) return incompleteValue();
    const stackKey = `${module.file}\0export\0${exportName}`;
    if (stack.has(stackKey)) return incompleteValue();
    const nextStack = new Set(stack).add(stackKey);
    const explicit = module.parsed.exports.get(exportName) ?? [];
    if (explicit.length > 0) {
      const values: ResolvedValue[] = [];
      for (const binding of explicit) {
        if (binding.kind === "local") {
          values.push(
            await this.resolveLocal(
              module,
              binding.localName,
              depth,
              state,
              nextStack,
            ),
          );
        } else if (binding.kind === "expression") {
          values.push(
            await this.resolveExpression(
              module,
              binding.expression,
              depth,
              state,
              nextStack,
            ),
          );
        } else {
          values.push(
            await this.resolveImportedExport(
              module,
              binding.moduleSpecifier,
              binding.importedName,
              depth,
              state,
              nextStack,
            ),
          );
        }
      }
      return mergeValues(values);
    }

    const values: ResolvedValue[] = [];
    const owners = new Map<string, LoadedModule>();
    for (const moduleSpecifier of module.parsed.exportStars) {
      if (!isRelativeModuleSpecifier(moduleSpecifier)) {
        values.push(incompleteValue());
        continue;
      }
      const loaded = await this.loadRelativeModule(
        module.file,
        moduleSpecifier,
        depth + 1,
        state,
      );
      if (loaded.status !== "loaded" || !loaded.module.parsed.parseable) {
        values.push(incompleteValue());
        continue;
      }
      const exportedNames = await this.collectExportedNames(
        loaded.module,
        depth + 1,
        state,
        nextStack,
      );
      if (exportedNames.incomplete) values.push(incompleteValue());
      if (exportedNames.names.has(exportName)) {
        owners.set(loaded.module.file, loaded.module);
      }
    }
    if (owners.size > 0) {
      const resolvedOwners: ResolvedValue[] = [];
      for (const owner of owners.values()) {
        resolvedOwners.push(
          await this.resolveExport(
            owner,
            exportName,
            depth + 1,
            state,
            nextStack,
          ),
        );
      }
      values.push(
        equivalentResolvedBinding(resolvedOwners) ?? incompleteValue(),
      );
    }
    return mergeValues(values);
  }

  private async resolveImportedExport(
    module: LoadedModule,
    moduleSpecifier: string,
    importedName: string,
    depth: number,
    state: ResolverState,
    stack: Set<string>,
  ): Promise<ResolvedValue> {
    if (!this.admitResolutionStep(state)) return incompleteValue();
    if (officialFactory(moduleSpecifier, importedName)) {
      return { ...EMPTY_VALUE, factory: true };
    }
    if (!isRelativeModuleSpecifier(moduleSpecifier)) {
      if (importedName === CURRENT_FACTORY || importedName === LEGACY_FACTORY) {
        return EMPTY_VALUE;
      }
      return { ...EMPTY_VALUE, unresolvedExternal: true };
    }
    const loaded = await this.loadRelativeModule(
      module.file,
      moduleSpecifier,
      depth + 1,
      state,
    );
    if (loaded.status !== "loaded" || !loaded.module.parsed.parseable) {
      return incompleteValue();
    }
    return this.resolveExport(
      loaded.module,
      importedName,
      depth + 1,
      state,
      stack,
    );
  }

  private async resolveLocal(
    module: LoadedModule,
    localName: string,
    depth: number,
    state: ResolverState,
    stack: Set<string>,
  ): Promise<ResolvedValue> {
    if (!this.admitResolutionStep(state)) return incompleteValue();
    const stackKey = `${module.file}\0local\0${localName}`;
    if (stack.has(stackKey)) return incompleteValue();
    const binding = module.parsed.bindings.get(localName);
    if (!binding) return incompleteValue();
    const nextStack = new Set(stack).add(stackKey);
    if (binding.kind === "factory") {
      return { ...EMPTY_VALUE, factory: true };
    }
    if (binding.kind === "namespace") {
      return { ...EMPTY_VALUE, namespaces: [binding.moduleSpecifier] };
    }
    if (binding.kind === "import") {
      return this.resolveImportedExport(
        module,
        binding.moduleSpecifier,
        binding.importedName,
        depth,
        state,
        nextStack,
      );
    }
    return this.resolveExpression(
      module,
      binding.expression,
      depth,
      state,
      nextStack,
    );
  }

  private async resolveExpression(
    module: LoadedModule,
    expression: ExpressionFact,
    depth: number,
    state: ResolverState,
    stack: Set<string>,
  ): Promise<ResolvedValue> {
    if (!this.admitResolutionStep(state)) return incompleteValue();
    if (expression.kind === "normal") return EMPTY_VALUE;
    if (expression.kind === "callable") {
      return { ...EMPTY_VALUE, callable: true };
    }
    if (expression.kind === "dynamic") return incompleteValue();
    if (expression.kind === "identifier") {
      return this.resolveLocal(module, expression.name, depth, state, stack);
    }
    if (expression.kind === "property") {
      const target = await this.resolveExpression(
        module,
        expression.target,
        depth,
        state,
        stack,
      );
      const values: ResolvedValue[] = [];
      if (target.incomplete) values.push(incompleteValue());
      if (target.unresolvedExternal) {
        values.push({ ...EMPTY_VALUE, unresolvedExternal: true });
      }
      for (const namespace of target.namespaces) {
        values.push(
          await this.resolveImportedExport(
            module,
            namespace,
            expression.name,
            depth,
            state,
            stack,
          ),
        );
      }
      if (target.namespaces.length === 0) values.push(incompleteValue());
      return mergeValues(values);
    }

    const callee = await this.resolveExpression(
      module,
      expression.callee,
      depth,
      state,
      stack,
    );
    if (!callee.factory) {
      const knownLocalLookalike =
        expression.callee.kind === "identifier" &&
        (expression.callee.name === CURRENT_FACTORY ||
          expression.callee.name === LEGACY_FACTORY);
      if (callee.callable && !knownLocalLookalike) return incompleteValue();
      return callee.incomplete || callee.unresolvedExternal
        ? {
            ...EMPTY_VALUE,
            incomplete: callee.incomplete,
            unresolvedExternal: callee.unresolvedExternal,
          }
        : EMPTY_VALUE;
    }
    const proof: AgentProof = {
      id: `${module.file}:${expression.position}`,
      name: expression.declaredName,
    };
    return {
      factory: false,
      namespaces: [],
      agents: new Map([[proof.id, proof]]),
      incomplete: callee.incomplete,
      unresolvedExternal: callee.unresolvedExternal,
      callable: false,
    };
  }
}

function discoveryResult(
  status: "absent" | "not-agent",
  fingerprints: ReadonlySet<string>,
  budget: CandidateBudget,
): AgentSourceDiscoveryResult;
function discoveryResult(
  status: "agent",
  fingerprints: ReadonlySet<string>,
  budget: CandidateBudget,
  name: string | null,
): AgentSourceDiscoveryResult;
function discoveryResult(
  status: "incomplete",
  fingerprints: ReadonlySet<string>,
  budget: CandidateBudget,
  reason: Extract<
    AgentSourceDiscoveryResult,
    { status: "incomplete" }
  >["reason"],
): AgentSourceDiscoveryResult;
function discoveryResult(
  status: "absent" | "not-agent" | "agent" | "incomplete",
  fingerprints: ReadonlySet<string>,
  budget: CandidateBudget,
  detail?: string | null,
): AgentSourceDiscoveryResult {
  const sortedFingerprints = [...fingerprints].sort(compareText);
  const watchPaths = sortedFingerprints
    .filter((fingerprint) => {
      const fields = fingerprint.split("\0");
      return (
        fields.length >= 5 ||
        fields[1] === "<absent>" ||
        fields[1] === "<not-file>" ||
        fields[1] === "<symlink>" ||
        fields[1] === "<unreadable>" ||
        fields[1] === "<unreadable-realpath>" ||
        fields[1] === "<unreadable-content>"
      );
    })
    .map((fingerprint) => fingerprint.slice(0, fingerprint.indexOf("\0")))
    .filter((observedPath) => path.isAbsolute(observedPath));
  const common = {
    observations: sortedFingerprints,
    watchPaths: [...new Set(watchPaths)].sort(compareText),
    fingerprint: JSON.stringify(sortedFingerprints),
    modules: budget.modules.size,
    bytes: budget.bytes,
    lookups: budget.lookups,
  };
  if (status === "agent") {
    return { status, name: detail ?? null, ...common };
  }
  if (status === "incomplete") {
    return {
      status,
      reason: detail as Extract<
        AgentSourceDiscoveryResult,
        { status: "incomplete" }
      >["reason"],
      ...common,
    };
  }
  return { status, ...common };
}
