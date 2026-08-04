#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_ALLOWLIST_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts/agent-studio-terminology-allowlist.json",
);

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
]);
const SCANNED_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ".json",
]);
const SKIPPED_PATH_PARTS = new Set([
  "__fixtures__",
  "__snapshots__",
  "__tests__",
  "dist",
  "e2e",
  "node_modules",
  "release",
  "test",
  "tests",
]);
const TEST_FILE_RE = /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/;
const WORKFLOW_TOKEN_RE = /workflows?/giu;

const STATIC_TARGETS = [
  ".github/workflows/desktop-release.yml",
  "package.json",
  "packages/agent-core/package.json",
  "packages/agent-core/src",
  "packages/agent-core/templates",
  "packages/agent-studio",
  "packages/cli/package.json",
  "packages/cli/src",
  "packages/cli/templates",
  "packages/harness/package.json",
  "packages/harness/README.md",
  "packages/harness/src/cli",
  "packages/harness/src/core",
  "packages/harness/src/profiles",
  "packages/harness/src/server",
  "packages/harness/src/shared",
  "packages/harness/web/index.html",
  "packages/harness/web/public",
  "packages/harness/web/src",
  "packages/harness-desktop/electron-builder.yml",
  "packages/harness-desktop/package.json",
  "packages/harness-desktop/src",
  "examples/registry.json",
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isScannable(relativePath) {
  const normalized = toPosix(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => SKIPPED_PATH_PARTS.has(part))) return false;
  if (TEST_FILE_RE.test(normalized)) return false;
  return SCANNED_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

async function collectFiles(rootDir, relativeTarget) {
  const absoluteTarget = path.join(rootDir, relativeTarget);
  let entries;
  try {
    entries = await readdir(absoluteTarget, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOTDIR") {
      return isScannable(relativeTarget) ? [toPosix(relativeTarget)] : [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const child = path.join(relativeTarget, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_PATH_PARTS.has(entry.name))
        files.push(...(await collectFiles(rootDir, child)));
    } else if (entry.isFile() && isScannable(child)) {
      files.push(toPosix(child));
    }
  }
  return files;
}

function registeredExampleTargets(registry) {
  const templates = Array.isArray(registry?.templates)
    ? registry.templates
    : [];
  return templates
    .map((template) => template?.sourcePath)
    .filter(
      (sourcePath) =>
        typeof sourcePath === "string" && sourcePath.startsWith("examples/"),
    );
}

export async function collectRepositoryFiles(rootDir = REPOSITORY_ROOT) {
  const registry = JSON.parse(
    await readFile(path.join(rootDir, "examples/registry.json"), "utf8"),
  );
  const targets = [...STATIC_TARGETS, ...registeredExampleTargets(registry)];
  const files = new Set();
  for (const target of targets) {
    for (const file of await collectFiles(rootDir, target)) files.add(file);
  }
  return [...files].sort();
}

function sourceKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (extension === ".json") return "json";
  return "text";
}

function scriptKind(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isModuleSpecifier(node) {
  const parent = node.parent;
  return (
    (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
    (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
    ts.isExternalModuleReference(parent) ||
    ts.isImportTypeNode(parent)
  );
}

function isTypeOnlyPropertyName(node) {
  const parent = node.parent;
  return (
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node)
  );
}

function isTypeOnlyLiteral(node) {
  return ts.isLiteralTypeNode(node.parent);
}

function codeSegments(source) {
  const file = ts.createSourceFile(
    source.path,
    source.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(source.path),
  );
  const segments = [];

  const push = (node, value) => {
    if (!value) return;
    const { line, character } = file.getLineAndCharacterOfPosition(
      node.getStart(file),
    );
    segments.push({ value, line: line + 1, column: character + 1 });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      push(node, node.getText(file));
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (
        !isModuleSpecifier(node) &&
        !isTypeOnlyPropertyName(node) &&
        !isTypeOnlyLiteral(node)
      ) {
        push(node, node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return segments;
}

function blankComment(comment) {
  return comment.replace(/[^\n]/g, " ");
}

function stripYamlSyntaxComment(line) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/u.test(line[index - 1]))) {
      return `${line.slice(0, index)}${" ".repeat(line.length - index)}`;
    }
  }

  return line;
}

function yamlBlockScalar(line) {
  const unquoted = line.replace(
    /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/gu,
    (quoted) => " ".repeat(quoted.length),
  );
  if (!/(?:^|[:-?]\s+)[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/u.test(unquoted)) {
    return null;
  }
  const key = /([a-z0-9_-]+)\s*:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/iu.exec(
    unquoted,
  )?.[1];
  return { stripHashComments: key === "run" };
}

function stripYamlComments(content) {
  let block = null;
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const indent = line.match(/^\s*/u)?.[0].length ?? 0;

      if (block !== null) {
        if (trimmed === "" || indent > block.parentIndent) {
          return block.stripHashComments ? stripYamlSyntaxComment(line) : line;
        }
        block = null;
      }

      const stripped = stripYamlSyntaxComment(line);
      const scalar = yamlBlockScalar(stripped);
      if (scalar) block = { parentIndent: indent, ...scalar };
      return stripped;
    })
    .join("\n");
}

function stripTextComments(content, extension) {
  let stripped = content.replace(/<!--[\s\S]*?-->/g, blankComment);
  if (extension === ".css") {
    stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, blankComment);
  } else if (extension === ".yaml" || extension === ".yml") {
    stripped = stripYamlComments(stripped);
  }
  return stripped;
}

function textSegments(source) {
  return [
    {
      value: stripTextComments(
        source.content,
        path.extname(source.path).toLowerCase(),
      ),
      line: 1,
      column: 1,
    },
  ];
}

function jsonSegments(source) {
  const parsed = JSON.parse(source.content);
  const segments = [];
  const visit = (value, jsonPath, includeKeys = true) => {
    if (typeof value === "string") {
      segments.push({ value, line: 1, column: 1, jsonPath });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        visit(child, `${jsonPath}[${index}]`, includeKeys),
      );
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${jsonPath}.${key}`;
      if (includeKeys) {
        segments.push({
          value: key,
          line: 1,
          column: 1,
          jsonPath: `${childPath} (key)`,
        });
      }
      visit(child, childPath, includeKeys);
    }
  };

  if (path.basename(source.path) === "package.json") {
    for (const key of ["name", "description", "keywords", "bin"]) {
      if (key in parsed) visit(parsed[key], `$.${key}`, true);
    }
  } else {
    visit(parsed, "$");
  }
  return segments;
}

function sourceSegments(source) {
  const segments =
    source.kind === "code"
      ? codeSegments(source)
      : source.kind === "json"
        ? jsonSegments(source)
        : textSegments(source);
  if (source.kind !== "code") return segments;
  return segments.map((segment) => ({
    ...segment,
    value: segment.value
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
      .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " ")),
  }));
}

function compileAllowlist(entries) {
  const ids = new Set();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`allowlist entry ${index + 1} is not an object`);
    const { id, path: entryPath, pattern, reason, occurrences } = entry;
    if (typeof id !== "string" || id.trim() === "")
      throw new Error(`allowlist entry ${index + 1} has no id`);
    if (ids.has(id)) throw new Error(`duplicate allowlist id: ${id}`);
    ids.add(id);
    if (typeof entryPath !== "string" || entryPath.trim() === "") {
      throw new Error(`allowlist entry ${id} has no exact path`);
    }
    if (entryPath.includes("*") || entryPath.includes("?")) {
      throw new Error(
        `allowlist entry ${id} must use an exact path, not a glob`,
      );
    }
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error(`allowlist entry ${id} has no pattern`);
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`allowlist entry ${id} has no compatibility reason`);
    }
    if (!Number.isInteger(occurrences) || occurrences < 1) {
      throw new Error(
        `allowlist entry ${id} must declare a positive occurrence count`,
      );
    }
    return { ...entry, regex: new RegExp(pattern, "giu"), used: 0 };
  });
}

function patternCovers(entry, value, tokenStart, tokenEnd) {
  entry.regex.lastIndex = 0;
  for (const match of value.matchAll(entry.regex)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start <= tokenStart && end >= tokenEnd) return true;
  }
  return false;
}

function lineAt(segment, tokenIndex) {
  const prefix = segment.value.slice(0, tokenIndex);
  const newlines = prefix.match(/\n/g)?.length ?? 0;
  if (newlines === 0)
    return { line: segment.line, column: segment.column + tokenIndex };
  return {
    line: segment.line + newlines,
    column: prefix.length - prefix.lastIndexOf("\n"),
  };
}

function contextAt(value, index) {
  const lineStart = value.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = value.indexOf("\n", index);
  return value
    .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    .trim()
    .slice(0, 240);
}

export function auditSources({ sources, allowlist = [] }) {
  const compiled = compileAllowlist(allowlist);
  const violations = [];

  for (const source of sources) {
    for (const segment of sourceSegments(source)) {
      WORKFLOW_TOKEN_RE.lastIndex = 0;
      for (const match of segment.value.matchAll(WORKFLOW_TOKEN_RE)) {
        const tokenStart = match.index;
        const tokenEnd = tokenStart + match[0].length;
        const allowed = compiled.find(
          (entry) =>
            entry.path === source.path &&
            patternCovers(entry, segment.value, tokenStart, tokenEnd),
        );
        if (allowed) {
          allowed.used += 1;
          continue;
        }
        const position = lineAt(segment, tokenStart);
        violations.push({
          path: source.path,
          line: position.line,
          column: position.column,
          token: match[0],
          context: segment.jsonPath ?? contextAt(segment.value, tokenStart),
        });
      }
    }
  }

  return {
    violations,
    unusedAllowlist: compiled
      .filter((entry) => entry.used !== entry.occurrences)
      .map(({ regex: _regex, ...entry }) => entry),
  };
}

export async function auditRepository({
  rootDir = REPOSITORY_ROOT,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
} = {}) {
  const [files, allowlistRaw] = await Promise.all([
    collectRepositoryFiles(rootDir),
    readFile(allowlistPath, "utf8"),
  ]);
  const sources = await Promise.all(
    files.map(async (filePath) => ({
      path: filePath,
      kind: sourceKind(filePath),
      content: await readFile(path.join(rootDir, filePath), "utf8"),
    })),
  );
  return {
    files,
    ...auditSources({ sources, allowlist: JSON.parse(allowlistRaw) }),
  };
}

function formatFailure(result) {
  const lines = [];
  if (result.violations.length > 0) {
    lines.push("Human-readable Workflow terminology found:");
    for (const violation of result.violations) {
      lines.push(
        `  ${violation.path}:${violation.line}:${violation.column} ${violation.token} — ${violation.context}`,
      );
    }
  }
  if (result.unusedAllowlist.length > 0) {
    lines.push("Stale terminology allowlist entries found:");
    for (const entry of result.unusedAllowlist) {
      lines.push(
        `  ${entry.id} — ${entry.path} / ${entry.pattern} (expected ${entry.occurrences}, matched ${entry.used})`,
      );
    }
  }
  return lines.join("\n");
}

async function main() {
  const result = await auditRepository();
  if (result.violations.length > 0 || result.unusedAllowlist.length > 0) {
    console.error(formatFailure(result));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Agent Studio terminology check passed (${result.files.length} files, no stale allowlist entries).`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
