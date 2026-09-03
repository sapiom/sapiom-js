#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isRegisteredProjectCopyAsset,
  isRegisteredProjectCopyPathIgnored,
} from "./examples-copy-check.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");

const STATIC_PROVIDER_NEUTRAL_COPY_TARGETS = [
  "examples/registry.json",
  // These examples are not currently registered, but were part of the original
  // provider-copy audit and remain protected until they join or leave the repo.
  "examples/durable-backfill/index.ts",
  "examples/personalized-media-at-scale/AGENTS.md",
  "examples/personalized-media-at-scale/README.md",
  "examples/personalized-media-at-scale/index.ts",
  "packages/harness/web/src/components/SecretAddDialog.tsx",
  "packages/harness/web/src/components/SecretImportDialog.tsx",
  "packages/harness/web/src/components/SessionStepsBar.tsx",
  "packages/sandbox/README.md",
  "packages/sandbox/src/multipart.ts",
  "packages/sandbox/src/types.ts",
  "packages/tools/src/content-generation/index.ts",
  "packages/tools/src/llm/index.ts",
  "packages/tools/src/sandboxes/index.ts",
  "packages/tools/src/sandboxes/multipart.ts",
];

const REQUIRED_CONTRACT_PATTERNS = [
  /\bfal-ai\/[a-z0-9._/-]+/giu,
  /\bEXECUTION_ENVIRONMENT_BLAXEL_SANDBOX\b/gu,
  /\bblaxel_sandbox\b/giu,
  /\/blaxel(?:\/[a-z0-9._/-]*)?/giu,
  /ghcr\.io\/blaxel-ai\/sandbox:latest/giu,
  /"provider"\s*:\s*"(?:anthropic|openai)"/giu,
  /\b(?:Anthropic|OpenAI) API key\b/g,
];

const REQUIRED_CONTRACT_PATTERNS_BY_PATH = {
  "packages/tools/src/content-generation/index.ts": [
    /"fal"/giu,
    /the fal adapter maps fal's/giu,
    /Some Fal video operations/gu,
  ],
  "packages/tools/src/llm/index.ts": [
    /\banthropic\/v1\/messages/gu,
    /openai\/v1\/chat\/completions/gu,
    /\bAnthropic messages shape\b/g,
    /\bAnthropic Messages\b/g,
    /\bAnthropic shape\b/g,
    /\bOpenAI Chat Completions\b/g,
    /\banthropicBaseUrl\b/g,
    /shape\?:\s*"anthropic"\s*\|\s*"openai"/g,
    /`shape:\s*"openai"`/g,
    /opts\.shape\s*===\s*"openai"/g,
    /\{\s*anthropic:\s*string;\s*openai:\s*string\s*\}/g,
  ],
  "packages/tools/src/sandboxes/index.ts": [/"blaxel"/giu],
  // `@sapiom/langchain-classic` binds LangChain's provider-specific chat models, so the provider
  // names ARE its public contract — it exports `SapiomChatOpenAI` / `SapiomChatAnthropic` over the
  // `@langchain/openai` / `@langchain/anthropic` peers. Unmasked narrowly, one usage at a time,
  // rather than skipping the file: the rest of this published README stays audited, so a stray
  // `fal` or `blaxel` in it is still caught.
  "packages/langchain-classic/README.md": [
    // Peer dependency package names, in install commands and prose.
    /@langchain\/(?:openai|anthropic)/giu,
    // The exported binding classes and the LangChain base classes they wrap.
    /\b(?:Sapiom)?Chat(?:OpenAI|Anthropic)\b/gu,
    // "Works with any LangChain model (OpenAI, Anthropic, etc.)".
    /\(OpenAI, Anthropic, etc\.\)/gu,
    // Section labels in the install snippet and the usage example.
    /# or for OpenAI:/gu,
    /\/\/ (?:OpenAI|Anthropic)$/gmu,
    // Example variable names bound to each class.
    /\bconst (?:openai|anthropic)\b/gu,
  ],
};

const FORBIDDEN_PROVIDER_COPY_RE =
  /\b(?:anthropic|openai|hunter|fal(?:\.ai)?|blaxel|firecracker)\b|claude code account/giu;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function collectRegisteredExampleAssets(
  rootDir,
  sourcePath,
  currentPath = sourcePath,
) {
  const assets = [];
  const entries = await readdir(path.join(rootDir, currentPath), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const childPath = toPosix(path.join(currentPath, entry.name));
    const relativePath = toPosix(path.relative(sourcePath, childPath));
    if (entry.isDirectory()) {
      if (!isRegisteredProjectCopyPathIgnored(relativePath)) {
        assets.push(
          ...(await collectRegisteredExampleAssets(
            rootDir,
            sourcePath,
            childPath,
          )),
        );
      }
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name === "template.json" ||
        isRegisteredProjectCopyAsset(relativePath))
    ) {
      assets.push(childPath);
    }
  }
  return assets;
}

/** Directories never walked when discovering published markdown. */
const UNWALKED_DIRECTORIES = new Set([
  "node_modules",
  // Build output.
  //
  // INVARIANT: no published package emits markdown into `dist`, so `dist` markdown could only be a
  // copy of `src`, which IS audited. Every published build is `tsc` plus a one-line `package.json`
  // write, with ONE exception worth knowing: `@sapiom/harness` also runs `vite build` into
  // `dist/web`, and vite copies its `publicDir` VERBATIM — so a `.md` dropped in `web/public` would
  // publish unaudited. There is none today. (`harness-desktop` also has a copy step but is
  // `private: true`, so it never publishes.)
  //
  // RE-CHECK THIS if a build starts emitting or copying docs into `dist` — the exclusion becomes a
  // silent hole and this entry should go. Note the set is deliberately asymmetric: other published
  // output directories (`agent-studio`'s `bin` / `lib`, `agent-core`'s `skills` / `templates`) ARE
  // walked; only generated-from-`src` output is skipped. Secondary benefit — the audited-file count
  // does not depend on whether the tree happens to be built.
  "dist",
]);

/**
 * Translate a `files` entry to a matcher. npm `files` accepts literal paths, directories, and
 * globs — `@sapiom/tools` ships a recursive README glob — so a plain `endsWith` comparison would
 * miss most of them. A double-star segment spans any number of directories; a single star stays
 * within one path segment.
 */
function filesEntryToRegExp(entry) {
  const expanded = entry
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${expanded}$`);
}

/** Every markdown file under `relativeDir`, recursively. Missing directory ⇒ none. */
async function collectMarkdownUnder(rootDir, relativeDir) {
  let entries;
  try {
    entries = await readdir(path.join(rootDir, relativeDir), {
      withFileTypes: true,
    });
  } catch {
    return []; // not built / not present — nothing published from here
  }
  const found = [];
  for (const entry of entries) {
    const childPath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (UNWALKED_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await collectMarkdownUnder(rootDir, childPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(childPath);
    }
  }
  return found;
}

/**
 * Markdown that is PUBLISHED to npm, derived from each package's own `files` entries rather than
 * listed here. Anything shipped in a tarball is unretractable once released, so the audit has to
 * track whatever `files` actually ships — enumerating today's matches would silently miss the next
 * file or directory someone adds. Both forms count: a recursive markdown glob, and a plain
 * DIRECTORY entry (`skills`, `templates`), which ships every `.md` beneath it.
 *
 * CHANGELOGs are excluded — append-only release history whose old entries must not be rewritten.
 */
async function collectPublishedMarkdownTargets(rootDir) {
  const targets = [];
  const packageDirs = await readdir(path.join(rootDir, "packages"), {
    withFileTypes: true,
  });
  for (const packageEntry of packageDirs) {
    if (!packageEntry.isDirectory()) continue;
    const packageDir = path.posix.join("packages", packageEntry.name);
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(rootDir, packageDir, "package.json"), "utf8"),
      );
    } catch {
      continue; // no manifest ⇒ nothing is published from this directory
    }
    if (!Array.isArray(manifest.files)) continue;
    // A directory entry ships every `.md` beneath it; a markdown entry may be a glob.
    const matchers = manifest.files
      .filter((entry) => typeof entry === "string")
      .map((entry) =>
        filesEntryToRegExp(entry.endsWith(".md") ? entry : `${entry}/**/*.md`),
      );
    if (matchers.length === 0) continue;
    for (const markdownPath of await collectMarkdownUnder(
      rootDir,
      packageDir,
    )) {
      const relativeToPackage = path.posix.relative(packageDir, markdownPath);
      if (path.posix.basename(relativeToPackage) === "CHANGELOG.md") continue;
      if (!matchers.some((matcher) => matcher.test(relativeToPackage)))
        continue;
      targets.push(markdownPath);
    }
  }
  return targets;
}

/**
 * Pending changesets. These become the published CHANGELOG entry verbatim, so a provider name here
 * reaches npm and cannot be edited afterwards — the one surface with no correction window at all.
 */
async function collectChangesetTargets(rootDir) {
  const entries = await readdir(path.join(rootDir, ".changeset"), {
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "README.md",
    )
    .map((entry) => path.posix.join(".changeset", entry.name));
}

export async function collectProviderNeutralCopyTargets(
  rootDir = REPOSITORY_ROOT,
) {
  const registry = JSON.parse(
    await readFile(path.join(rootDir, "examples/registry.json"), "utf8"),
  );
  const targets = new Set(STATIC_PROVIDER_NEUTRAL_COPY_TARGETS);
  for (const target of await collectPublishedMarkdownTargets(rootDir)) {
    targets.add(target);
  }
  for (const target of await collectChangesetTargets(rootDir)) {
    targets.add(target);
  }
  for (const template of registry.templates ?? []) {
    if (typeof template?.sourcePath !== "string") continue;
    for (const asset of await collectRegisteredExampleAssets(
      rootDir,
      template.sourcePath,
    )) {
      targets.add(asset);
    }
  }
  return [...targets].sort();
}

function maskRequiredContracts(content, sourcePath) {
  const patterns = [
    ...REQUIRED_CONTRACT_PATTERNS,
    ...(REQUIRED_CONTRACT_PATTERNS_BY_PATH[sourcePath] ?? []),
  ];
  return patterns.reduce(
    (masked, pattern) =>
      masked.replace(pattern, (value) => " ".repeat(value.length)),
    content,
  );
}

function positionAt(content, index) {
  const prefix = content.slice(0, index);
  const lines = prefix.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

export function findProviderCopyMentions(content, sourcePath = "fixture") {
  const masked = maskRequiredContracts(content, sourcePath);
  return [...masked.matchAll(FORBIDDEN_PROVIDER_COPY_RE)].map((match) => ({
    path: sourcePath,
    token: match[0],
    ...positionAt(masked, match.index),
  }));
}

export async function auditProviderNeutralCopy(rootDir = REPOSITORY_ROOT) {
  const files = await collectProviderNeutralCopyTargets(rootDir);
  const violations = [];
  for (const target of files) {
    const content = await readFile(path.join(rootDir, target), "utf8");
    violations.push(...findProviderCopyMentions(content, target));
  }
  return { files, violations };
}

async function main() {
  const result = await auditProviderNeutralCopy();
  if (result.violations.length > 0) {
    console.error(
      "Underlying provider names found in audited user-facing copy:",
    );
    for (const violation of result.violations) {
      console.error(
        `  ${violation.path}:${violation.line}:${violation.column} ${violation.token}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Provider-neutral copy check passed (${result.files.length} audited files).`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
