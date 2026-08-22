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
};

const FORBIDDEN_PROVIDER_COPY_RE =
  /\b(?:anthropic|openai|hunter|fal(?:\.ai)?|blaxel|firecracker|fireworks)\b|claude code account/giu;

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

export async function collectProviderNeutralCopyTargets(
  rootDir = REPOSITORY_ROOT,
) {
  const registry = JSON.parse(
    await readFile(path.join(rootDir, "examples/registry.json"), "utf8"),
  );
  const targets = new Set(STATIC_PROVIDER_NEUTRAL_COPY_TARGETS);
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
