/**
 * What an agent's own code proves about its links to other agents: the agents it runs or
 * launches, the timers it schedules on another agent, the event types it emits, and the
 * resources (vault keys, databases) it uses. Syntax only, no type checker, like the per-agent
 * source scan this builds on. A fact is kept only with the code location that proves it.
 *
 * A call target is resolved when the code makes it knowable without running anything:
 * a string literal; a const (in this file or imported by a relative path); every value of a
 * const object or array indexed at run time; a zod `.default("…")` on the input field the
 * call reads; a `process.env` key set in the agent's `sapiom.json`; or a helper called with
 * one string literal (`agentSlug("controller")`), matched against the project's agent keys.
 * Anything else is reported as unresolved, never guessed.
 */
import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

import {
  attributeTo,
  collectSupportedNamespaces,
  invocationMode,
  listSourceFilesWithObservations,
  propertyAccessChain,
  readWorkflowSourceFile,
  stepBlockRanges,
  unwrapExpression,
  type StepBlock,
} from "./source-scan.js";
import type { EdgeKind, Evidence } from "./types.js";

/** A resolved target. `alias` marks a helper-call literal that names an agent by key. */
export interface ResolvedValue {
  value: string;
  alias?: true;
  /** One possible value the code does not make knowable (a dynamic entry of a const map). */
  dynamic?: true;
}

export interface CallFact {
  kind: Exclude<EdgeKind, "event">;
  targets: ResolvedValue[] | null;
  evidence: Evidence;
}

export interface EmitFact {
  eventType: string;
  evidence: Evidence;
}

export interface AgentCodeFacts {
  calls: CallFact[];
  emits: EmitFact[];
  dynamicEmits: Evidence[];
  resources: string[];
  /** `defineAgent({ name, description })` literals, when present. */
  declaredName?: string;
  declaredDescription?: string;
  /** Step name → its `defineStep` location. */
  stepLocations: Map<string, { file: string; line: number }>;
}

const TEST_FILE = /\.(test|spec|perf\.test)\.[cm]?tsx?$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__fixtures__", "fixtures"]);
const IMPORT_DEPTH = 3;
const RESOLVE_DEPTH = 6;

interface SourceUnit {
  /** False for a file outside the agent folder, reached through a relative import. */
  own: boolean;
  /** For an imported file: whether a position sits in code this agent reaches. */
  inScope: (position: number) => boolean;
  abs: string;
  /** POSIX path relative to the project root, as evidence shows it. */
  rel: string;
  sourceFile: ts.SourceFile;
  blocks: StepBlock[];
}

function isTestPath(relativeToAgent: string): boolean {
  const parts = relativeToAgent.split(path.sep);
  return TEST_FILE.test(relativeToAgent) || parts.slice(0, -1).some((part) => TEST_DIRS.has(part));
}

function stringLiteralValue(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function objectProperty(object: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      found = null;
      continue;
    }
    if (propertyNameText(property.name) !== key) continue;
    if (ts.isPropertyAssignment(property)) found = property.initializer;
    else if (ts.isShorthandPropertyAssignment(property)) found = property.name;
    else found = null;
  }
  return found;
}

/** The single-line source text of a call, trimmed for evidence. */
function evidenceText(unit: SourceUnit, node: ts.Node): string {
  const start = node.getStart(unit.sourceFile);
  const text = unit.sourceFile.text;
  const lineEnd = text.indexOf("\n", start);
  const line = text.slice(start, lineEnd === -1 ? undefined : lineEnd).trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function evidenceAt(unit: SourceUnit, node: ts.Node): Evidence {
  const start = node.getStart(unit.sourceFile);
  const { line } = unit.sourceFile.getLineAndCharacterOfPosition(start);
  const evidence: Evidence = { file: unit.rel, line: line + 1, text: evidenceText(unit, node) };
  const step = attributeTo(unit.blocks, start);
  if (step) evidence.step = step;
  return evidence;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

/** The nearest enclosing function that declares `name` as a parameter (callbacks inside a step close over it). */
function declaringFunction(node: ts.Node, name: string): ts.SignatureDeclaration | null {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionLike(current) &&
      current.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)
    ) {
      return current;
    }
  }
  return null;
}

/** A function that forwards one of its parameters as an emitted event type. */
interface EmitWrapper {
  unit: SourceUnit;
  name: string;
  parameterIndex: number;
}

export class ProjectSources {
  private readonly units = new Map<string, Promise<SourceUnit | null>>();

  constructor(
    private readonly projectRoot: string,
    private readonly knownSteps: (agentDir: string) => ReadonlySet<string> | null,
  ) {}

  /** The agent's own non-test sources plus the relative imports they reach inside the project. */
  async agentUnits(agentDir: string): Promise<SourceUnit[]> {
    const own = await listSourceFilesWithObservations(agentDir);
    const queue = own.files
      .filter((file) => !isTestPath(path.relative(agentDir, file)))
      .map((file) => ({ file, depth: 0 }));
    const seen = new Set(queue.map((item) => item.file));
    const units: SourceUnit[] = [];
    // Names each imported file is asked for; "*" when a namespace, default or re-export takes all.
    const importedNames = new Map<string, Set<string>>();
    while (queue.length > 0) {
      const { file, depth } = queue.shift()!;
      const unit = await this.load(file, agentDir);
      if (!unit) continue;
      units.push(unit);
      if (depth >= IMPORT_DEPTH) continue;
      for (const { target, names } of this.relativeImports(unit)) {
        const relative = path.relative(this.projectRoot, target);
        if (relative.startsWith("..") || isTestPath(relative)) continue;
        const wanted = importedNames.get(target) ?? new Set<string>();
        for (const name of names) wanted.add(name);
        importedNames.set(target, wanted);
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push({ file: target, depth: depth + 1 });
      }
    }
    for (const unit of units) {
      unit.inScope = unit.own ? () => true : reachableScope(unit.sourceFile, importedNames.get(unit.abs) ?? new Set());
    }
    return units.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  }

  private load(file: string, agentDir: string): Promise<SourceUnit | null> {
    const key = `${agentDir}\0${file}`;
    let pending = this.units.get(key);
    if (!pending) {
      pending = (async () => {
        // An agent folder may be its own git repository; the source reader refuses files under a
        // nested repo, so an agent's own files are confined to the agent folder itself.
        const inAgent = !path.relative(agentDir, file).startsWith("..");
        const content = await readWorkflowSourceFile(inAgent ? agentDir : this.projectRoot, file);
        if (content === null) return null;
        const sourceFile = ts.createSourceFile(
          path.basename(file),
          content,
          ts.ScriptTarget.Latest,
          true,
          path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        return {
          own: inAgent,
          inScope: () => true,
          abs: file,
          rel: path.relative(this.projectRoot, file).split(path.sep).join(path.posix.sep),
          sourceFile,
          blocks: stepBlockRanges(content, this.knownSteps(agentDir)),
        };
      })();
      this.units.set(key, pending);
    }
    return pending;
  }

  private relativeImports(unit: SourceUnit): Array<{ target: string; names: string[] }> {
    const targets: Array<{ target: string; names: string[] }> = [];
    for (const statement of unit.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier =
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      if (!specifier || !specifier.startsWith(".")) continue;
      const resolved = this.resolveModuleFile(unit.abs, specifier);
      if (resolved) targets.push({ target: resolved, names: importedNamesOf(statement) });
    }
    return targets;
  }

  private readonly exists = new Map<string, boolean>();

  /** Per scan, so a module created after one map call is seen by the next. */
  private resolveModuleFile(fromFile: string, specifier: string): string | null {
    const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.(m|c)?js$/, ""));
    for (const suffix of MODULE_SUFFIXES) {
      const candidate = base + suffix;
      if (!/\.[cm]?tsx?$/.test(candidate)) continue;
      let exists = this.exists.get(candidate);
      if (exists === undefined) {
        exists = fsExistsSync(candidate);
        this.exists.set(candidate, exists);
      }
      if (exists) return candidate;
    }
    return null;
  }

  /** The unit an import specifier points at, loaded under the same agent. */
  async importTarget(unit: SourceUnit, specifier: string, agentDir: string): Promise<SourceUnit | null> {
    if (!specifier.startsWith(".")) return null;
    const resolved = this.resolveModuleFile(unit.abs, specifier);
    if (!resolved) return null;
    const relative = path.relative(this.projectRoot, resolved);
    if (relative.startsWith("..")) return null;
    return this.load(resolved, agentDir);
  }
}

const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"];

function importedNamesOf(statement: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    return clause && ts.isNamedExports(clause)
      ? clause.elements.map((element) => element.propertyName?.text ?? element.name.text)
      : ["*"];
  }
  const clause = statement.importClause;
  if (!clause) return ["*"]; // side-effect import: its top-level code runs
  if (clause.name) return ["*"];
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return ["*"];
  return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
}

function topLevelName(statement: ts.Statement): string[] {
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    return [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  return [];
}

/**
 * The parts of an imported file an agent reaches: module-level statements that are not
 * declarations (they run on import), plus the declarations it imports by name and every
 * declaration in the file those refer to. A helper in a shared file that only another agent
 * calls is out of scope, so its calls are not this agent's.
 */
function reachableScope(sourceFile: ts.SourceFile, wanted: ReadonlySet<string>): (position: number) => boolean {
  if (wanted.has("*")) return () => true;
  const declarations = new Map<string, ts.Statement>();
  for (const statement of sourceFile.statements) {
    for (const name of topLevelName(statement)) declarations.set(name, statement);
  }
  const reached = new Set<ts.Statement>();
  const pending = [...wanted];
  while (pending.length > 0) {
    const statement = declarations.get(pending.pop()!);
    if (!statement || reached.has(statement)) continue;
    reached.add(statement);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && declarations.has(node.text)) pending.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  const ranges = sourceFile.statements
    .filter((statement) => reached.has(statement) || (topLevelName(statement).length === 0 && !ts.isImportDeclaration(statement)))
    .map((statement) => [statement.pos, statement.end] as const);
  return (position) => ranges.some(([start, end]) => position >= start && position < end);
}

function fsExistsSync(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

interface ResolveContext {
  sources: ProjectSources;
  agentDir: string;
  env: Readonly<Record<string, string>>;
}

/** The initializer of a top-level `const NAME = …` in the file. */
function topLevelConst(unit: SourceUnit, name: string): ts.Expression | null {
  for (const statement of unit.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

function importedBinding(unit: SourceUnit, name: string): { specifier: string; imported: string } | null {
  for (const statement of unit.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === name) {
        return {
          specifier: statement.moduleSpecifier.text,
          imported: element.propertyName?.text ?? element.name.text,
        };
      }
    }
  }
  return null;
}

/** Follow an identifier to the expression it is a const of, across one relative import hop at a time. */
async function definitionOf(
  context: ResolveContext,
  unit: SourceUnit,
  name: string,
  depth: number,
): Promise<{ unit: SourceUnit; expression: ts.Expression } | null> {
  if (depth > RESOLVE_DEPTH) return null;
  const local = topLevelConst(unit, name);
  if (local) return { unit, expression: local };
  const binding = importedBinding(unit, name);
  if (!binding) return null;
  const target = await context.sources.importTarget(unit, binding.specifier, context.agentDir);
  if (!target) return null;
  return definitionOf(context, target, binding.imported, depth + 1);
}

/** A zod field default for `field` declared anywhere in the file: `field: z.….default("x")`. */
function zodFieldDefault(unit: SourceUnit, field: string): string | null {
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === field) {
      for (let call: ts.Expression = node.initializer; ts.isCallExpression(call); ) {
        const callee = call.expression;
        if (!ts.isPropertyAccessExpression(callee)) break;
        if (callee.name.text === "default" && call.arguments.length === 1) {
          const literal = stringLiteralValue(call.arguments[0]!);
          if (literal) {
            found = literal;
            return;
          }
        }
        call = callee.expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.sourceFile);
  return found;
}

/** Every string a target expression can be, or null when the code does not say. */
async function resolveStrings(
  context: ResolveContext,
  unit: SourceUnit,
  expression: ts.Expression,
  depth = 0,
): Promise<ResolvedValue[] | null> {
  if (depth > RESOLVE_DEPTH) return null;
  const node = unwrapExpression(expression);
  const literal = stringLiteralValue(node);
  if (literal !== null) return [{ value: literal }];

  if (ts.isIdentifier(node)) {
    const definition = await definitionOf(context, unit, node.text, 0);
    return definition ? resolveStrings(context, definition.unit, definition.expression, depth + 1) : null;
  }

  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    const elements = ts.isArrayLiteralExpression(node)
      ? node.elements.filter((element) => !ts.isSpreadElement(element))
      : node.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) ? [property.initializer] : [],
        );
    const values: ResolvedValue[] = [];
    let dynamic = ts.isArrayLiteralExpression(node)
      ? node.elements.some((element) => ts.isSpreadElement(element))
      : node.properties.some((property) => !ts.isPropertyAssignment(property));
    for (const element of elements) {
      const resolved = await resolveStrings(context, unit, element, depth + 1);
      if (resolved) values.push(...resolved);
      else dynamic = true;
    }
    if (values.length === 0) return null;
    return dynamic ? [...values, { value: "", dynamic: true }] : values;
  }

  if (ts.isElementAccessExpression(node)) {
    const key = stringLiteralValue(unwrapExpression(node.argumentExpression));
    const collection = unwrapExpression(node.expression);
    if (key !== null && ts.isIdentifier(collection)) {
      // A fixed index picks one entry, not the whole collection.
      const definition = await definitionOf(context, unit, collection.text, 0);
      const target = definition ? unwrapExpression(definition.expression) : null;
      if (target && definition && ts.isObjectLiteralExpression(target)) {
        const property = objectProperty(target, key);
        return property ? resolveStrings(context, definition.unit, property, depth + 1) : null;
      }
    }
    // Indexed at run time: any value of the collection can be the target.
    return resolveStrings(context, unit, node.expression, depth + 1);
  }

  if (ts.isPropertyAccessExpression(node)) {
    const chain = propertyAccessChain(node);
    if (chain && chain.length === 3 && chain[0] === "process" && chain[1] === "env") {
      const value = context.env[chain[2]!];
      return value ? [{ value }] : null;
    }
    const object = unwrapExpression(node.expression);
    if (ts.isIdentifier(object)) {
      const definition = await definitionOf(context, unit, object.text, 0);
      const target = definition ? unwrapExpression(definition.expression) : null;
      if (target && definition && ts.isObjectLiteralExpression(target)) {
        const property = objectProperty(target, node.name.text);
        return property ? resolveStrings(context, definition.unit, property, depth + 1) : null;
      }
    }
    // `input.definition` read from the step's own input parameter: the schema default is the
    // target the code declares. A caller can pass another slug at run time; the map shows the
    // declared one, as the Canvas does.
    const isOwnParameter = ts.isIdentifier(object) && declaringFunction(node, object.text) !== null;
    const fallback = isOwnParameter ? zodFieldDefault(unit, node.name.text) : null;
    return fallback ? [{ value: fallback }] : null;
  }

  if (ts.isCallExpression(node)) {
    const literals = node.arguments.map((argument) => stringLiteralValue(argument));
    if (literals.length === 1 && literals[0]) return [{ value: literals[0], alias: true }];
  }

  return null;
}

function isCallTo(chain: string[] | null, ...suffix: string[]): boolean {
  if (!chain || chain.length < suffix.length) return false;
  return suffix.every((part, index) => chain[chain.length - suffix.length + index] === part);
}

function scheduleKind(object: ts.ObjectLiteralExpression): boolean {
  const kind = objectProperty(object, "kind");
  const value = kind ? stringLiteralValue(unwrapExpression(kind)) : null;
  return value !== null && value.startsWith("schedule_");
}

export async function agentCodeFacts(
  sources: ProjectSources,
  agentDir: string,
  env: Readonly<Record<string, string>>,
): Promise<AgentCodeFacts> {
  const context: ResolveContext = { sources, agentDir, env };
  const units = await sources.agentUnits(agentDir);
  const facts: AgentCodeFacts = {
    calls: [],
    emits: [],
    dynamicEmits: [],
    resources: [],
    stepLocations: new Map(),
  };
  const resources = new Set<string>();
  const wrappers: EmitWrapper[] = [];
  const pendingEmitCalls: Array<{ unit: SourceUnit; call: ts.CallExpression }> = [];

  for (const unit of units) {
    const namespaces = collectSupportedNamespaces(unit.sourceFile);
    for (const block of unit.blocks) {
      if (!facts.stepLocations.has(block.stepId)) {
        const { line } = unit.sourceFile.getLineAndCharacterOfPosition(block.start);
        facts.stepLocations.set(block.stepId, { file: unit.rel, line: line + 1 });
      }
    }

    const nodes: ts.CallExpression[] = [];
    const propertyNodes: ts.PropertyAssignment[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) nodes.push(node);
      if (ts.isPropertyAssignment(node)) propertyNodes.push(node);
      ts.forEachChild(node, collect);
    };
    collect(unit.sourceFile);

    for (const property of propertyNodes) {
      if (!unit.inScope(property.getStart(unit.sourceFile))) continue;
      if (propertyNameText(property.name) !== "dbHandle") continue;
      const value = stringLiteralValue(unwrapExpression(property.initializer));
      if (value) resources.add(`db:${value}`);
    }

    for (const call of nodes) {
      const chain = propertyAccessChain(call.expression);
      // Emit wrappers are definitions, found wherever they sit; every other call must be reachable.
      const reachable = unit.inScope(call.getStart(unit.sourceFile));
      const firstArgument = call.arguments[0] ? unwrapExpression(call.arguments[0]) : null;

      const emitType =
        isCallTo(chain, "events", "emit") && firstArgument && ts.isObjectLiteralExpression(firstArgument)
          ? objectProperty(firstArgument, "type")
          : null;
      const emitTypeNode = emitType ? unwrapExpression(emitType) : null;
      if (emitTypeNode && ts.isIdentifier(emitTypeNode)) {
        const owner = enclosingFunction(call);
        const parameterIndex = owner
          ? owner.parameters.findIndex(
              (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === emitTypeNode.text,
            )
          : -1;
        const ownerName = owner ? functionName(owner) : null;
        if (ownerName && parameterIndex >= 0) {
          wrappers.push({ unit, name: ownerName, parameterIndex });
          continue;
        }
      }
      if (!reachable) continue;

      const mode = invocationMode(call, namespaces, unit.sourceFile);
      if (mode) {
        for (const site of launchSpecs(unit, call, firstArgument)) {
          const definition = site.spec ? objectProperty(site.spec, "definition") : null;
          facts.calls.push({
            kind: "launch",
            targets: definition ? await resolveStrings(context, unit, definition) : null,
            evidence: site.evidence,
          });
        }
        continue;
      }

      if (
        firstArgument &&
        ts.isObjectLiteralExpression(firstArgument) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "create" &&
        (isCallTo(chain, "schedules", "create") || scheduleKind(firstArgument))
      ) {
        const definition = objectProperty(firstArgument, "definition");
        if (definition) {
          facts.calls.push({
            kind: "timer",
            targets: await resolveStrings(context, unit, definition),
            evidence: evidenceAt(unit, call.expression),
          });
        }
        continue;
      }

      if (isCallTo(chain, "events", "emit")) {
        recordEmits(facts, emitType ? await resolveStrings(context, unit, emitType) : null, evidenceAt(unit, call.expression));
        continue;
      }

      if (isCallTo(chain, "vault", "get") || isCallTo(chain, "vault", "getAll")) {
        const resolved = firstArgument ? await resolveStrings(context, unit, firstArgument) : null;
        for (const { value, dynamic } of resolved ?? []) if (!dynamic) resources.add(`vault:${value}`);
        continue;
      }
      if (isCallTo(chain, "database", "get")) {
        const resolved = firstArgument ? await resolveStrings(context, unit, firstArgument) : null;
        for (const { value, dynamic } of resolved ?? []) if (!dynamic) resources.add(`db:${value}`);
        continue;
      }

      if (ts.isIdentifier(call.expression)) pendingEmitCalls.push({ unit, call });
    }

    const declaration = defineAgentObject(unit);
    if (declaration) {
      const name = objectProperty(declaration, "name");
      const description = objectProperty(declaration, "description");
      const nameValue = name ? await resolveStrings(context, unit, name) : null;
      if (nameValue?.length === 1 && !nameValue[0]!.alias) facts.declaredName ??= nameValue[0]!.value;
      const descriptionValue = description ? stringLiteralValue(unwrapExpression(description)) : null;
      if (descriptionValue) facts.declaredDescription ??= descriptionValue;
    }
  }

  // Calls through an emit wrapper: `emit(ctx, db, "issue.created", …)` where `emit` forwards
  // its third parameter as the event type.
  for (const { unit, call } of pendingEmitCalls) {
    const callee = call.expression as ts.Identifier;
    const wrapper = await wrapperFor(context, unit, callee.text, wrappers);
    if (!wrapper) continue;
    const argument = call.arguments[wrapper.parameterIndex];
    recordEmits(facts, argument ? await resolveStrings(context, unit, argument) : null, evidenceAt(unit, call));
  }

  facts.resources = [...resources].sort();
  return facts;
}

/** A function's name, for a declaration or a `const name = (…) => …`. */
function functionName(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent.name.text;
  }
  return null;
}

/** The variable's object-literal initializer in the nearest enclosing scope that declares it. */
function localObject(call: ts.Node, name: string): ts.ObjectLiteralExpression | null {
  for (let scope = call.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
        const initializer = unwrapExpression(declaration.initializer);
        return ts.isObjectLiteralExpression(initializer) ? initializer : null;
      }
    }
  }
  return null;
}

/**
 * The launch spec objects a run/launch call can receive, each with the location that proves it:
 * the literal argument; a local `const spec = { … }`; or, when the spec is a parameter of a
 * helper, the object each call to that helper in the same file passes (one level).
 */
function launchSpecs(
  unit: SourceUnit,
  call: ts.CallExpression,
  argument: ts.Expression | null,
): Array<{ spec: ts.ObjectLiteralExpression | null; evidence: Evidence }> {
  const here = evidenceAt(unit, call.expression);
  if (!argument) return [{ spec: null, evidence: here }];
  if (ts.isObjectLiteralExpression(argument)) return [{ spec: argument, evidence: here }];
  if (!ts.isIdentifier(argument)) return [{ spec: null, evidence: here }];
  const local = localObject(call, argument.text);
  if (local) return [{ spec: local, evidence: here }];
  const owner = enclosingFunction(call);
  const index = owner
    ? owner.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === argument.text)
    : -1;
  const name = owner && index >= 0 ? functionName(owner) : null;
  if (!name) return [{ spec: null, evidence: here }];
  const sites: Array<{ spec: ts.ObjectLiteralExpression | null; evidence: Evidence }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      const passed = node.arguments[index] ? unwrapExpression(node.arguments[index]!) : null;
      const spec =
        passed && ts.isObjectLiteralExpression(passed)
          ? passed
          : passed && ts.isIdentifier(passed)
            ? localObject(node, passed.text)
            : null;
      sites.push({ spec, evidence: evidenceAt(unit, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.sourceFile);
  return sites.length > 0 ? sites : [{ spec: null, evidence: here }];
}

function recordEmits(facts: AgentCodeFacts, resolved: ResolvedValue[] | null, evidence: Evidence): void {
  if (!resolved || resolved.some((item) => item.dynamic)) facts.dynamicEmits.push(evidence);
  for (const { value, dynamic } of resolved ?? []) if (!dynamic) facts.emits.push({ eventType: value, evidence });
}

async function wrapperFor(
  context: ResolveContext,
  unit: SourceUnit,
  name: string,
  wrappers: readonly EmitWrapper[],
): Promise<EmitWrapper | null> {
  const local = wrappers.find((wrapper) => wrapper.unit === unit && wrapper.name === name);
  if (local) return local;
  const binding = importedBinding(unit, name);
  if (!binding) return null;
  const target = await context.sources.importTarget(unit, binding.specifier, context.agentDir);
  if (!target) return null;
  return wrappers.find((wrapper) => wrapper.unit.abs === target.abs && wrapper.name === binding.imported) ?? null;
}

function defineAgentObject(unit: SourceUnit): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineAgent" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(unwrapExpression(node.arguments[0]))
    ) {
      found = unwrapExpression(node.arguments[0]) as ts.ObjectLiteralExpression;
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.sourceFile);
  return found;
}

/** True when the folder's `index.ts` declares an agent. Cheap textual check used by discovery. */
export async function declaresAgent(dir: string): Promise<boolean> {
  try {
    const content = await fs.readFile(path.join(dir, "index.ts"), "utf8");
    return /\bdefineAgent\s*(<[^(]*>)?\s*\(/.test(content);
  } catch {
    return false;
  }
}
