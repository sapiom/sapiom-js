#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");

export const PROVIDER_NEUTRAL_COPY_TARGETS = [
  "examples/cold-outreach-engine/AGENTS.md",
  "examples/cold-outreach-engine/README.md",
  "examples/cold-outreach-engine/index.ts",
  "examples/cold-outreach-engine/package.json",
  "examples/cold-outreach-engine/template.json",
  "examples/personalized-media-at-scale/AGENTS.md",
  "examples/personalized-media-at-scale/README.md",
  "examples/personalized-media-at-scale/index.ts",
  "examples/registry.json",
  "examples/research-to-microsite/AGENTS.md",
  "examples/research-to-microsite/README.md",
  "examples/research-to-microsite/index.ts",
  "examples/scene-to-video/AGENTS.md",
  "examples/scene-to-video/README.md",
  "examples/scene-to-video/index.ts",
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
  /ghcr\.io\/blaxel-ai\/sandbox:latest/giu,
];

const REQUIRED_CONTRACT_PATTERNS_BY_PATH = {
  "packages/tools/src/content-generation/index.ts": [
    /"fal"/giu,
    /the fal adapter maps fal's/giu,
    /Some Fal video operations/gu,
  ],
  "packages/tools/src/sandboxes/index.ts": [/"blaxel"/giu],
};

const FORBIDDEN_PROVIDER_COPY_RE =
  /\b(?:hunter|fal(?:\.ai)?|blaxel|firecracker)\b|usually\s+anthropic|claude code account/giu;

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
  const violations = [];
  for (const target of PROVIDER_NEUTRAL_COPY_TARGETS) {
    const content = await readFile(path.join(rootDir, target), "utf8");
    violations.push(...findProviderCopyMentions(content, target));
  }
  return { files: PROVIDER_NEUTRAL_COPY_TARGETS, violations };
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
