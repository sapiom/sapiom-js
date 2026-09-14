#!/usr/bin/env node
/**
 * Move every platform-rules stamp this repo ships to a new content release
 * (SAP-3181).
 *
 *   node scripts/authoring-rules-stamp.mjs --from-served [URL]
 *   node scripts/authoring-rules-stamp.mjs --release 1.1 --digest 0123456789ab
 *
 * The backend serves the platform rules at GET /v1/agents/authoring-rules and
 * stamps each response with `X-Sapiom-Content-Release` / `X-Sapiom-Content-Digest`.
 * The skill's platform chapters, every AGENTS.md, examples/AUTHORING.md, the
 * `@sapiom/tools` JSDoc pointers and the constants in
 * packages/agent-core/src/authoring-rules.ts all record which release they were
 * written against, and `packages/agent-core/src/__tests__/authoring-rules-stamp.test.ts`
 * fails when any of them disagree. When a release is cut, re-read the summaries
 * against the new text, then run this once so the stamps move together.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDigest, restamp } from "./lib/authoring-rules-stamp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "https://api.sapiom.ai/v1/agents/authoring-rules";

/** Every file that carries a stamp in any of its forms. Mirrors the test's list. */
export function stampedFiles(root = ROOT) {
  const files = [
    "packages/agent-core/src/authoring-rules.ts",
    "packages/agent-core/skills/sapiom-agent-authoring/SKILL.md",
    "packages/agent-core/templates/default/.claude/skills/sapiom-agent-authoring/SKILL.md",
    "packages/agent-core/templates/coding-pause/.claude/skills/sapiom-agent-authoring/SKILL.md",
    "plugins/sapiom/skills/sapiom-agent-authoring/SKILL.md",
    "packages/agent-core/templates/default/AGENTS.md",
    "packages/agent-core/templates/coding-pause/AGENTS.md",
    "packages/cli/templates/default/AGENTS.md",
    "packages/tools/src/llm/index.ts",
    "packages/tools/src/models/index.ts",
    "examples/AUTHORING.md",
  ];
  const examples = path.join(root, "examples");
  for (const entry of readdirSync(examples)) {
    const agentsMd = path.join(examples, entry, "AGENTS.md");
    if (statSync(path.join(examples, entry)).isDirectory()) {
      try {
        statSync(agentsMd);
        files.push(path.relative(root, agentsMd));
      } catch {
        // an example without an AGENTS.md carries nothing to stamp
      }
    }
  }
  return files.map((f) => path.join(root, f));
}

function parseArgs(argv) {
  const args = { fromServed: false, url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from-served") {
      args.fromServed = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.url = argv[++i];
    } else if (arg === "--release") args.release = argv[++i];
    else if (arg === "--digest") args.digest = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

async function resolveStamp(args) {
  if (args.fromServed) {
    const response = await fetch(args.url, {
      headers: { Accept: "text/markdown" },
    });
    if (!response.ok)
      throw new Error(`${args.url} answered ${response.status}`);
    const release = response.headers.get("x-sapiom-content-release");
    const digest = response.headers.get("x-sapiom-content-digest");
    if (!release || !digest)
      throw new Error(`${args.url} sent no X-Sapiom-Content-* stamp headers`);
    return { release, digest };
  }
  if (!args.release || !args.digest) {
    throw new Error("pass --from-served [URL], or both --release and --digest");
  }
  return { release: args.release, digest: args.digest };
}

async function main() {
  const stamp = await resolveStamp(parseArgs(process.argv.slice(2)));
  if (!isDigest(stamp.digest))
    throw new Error(`digest must be 12 hex characters, got ${stamp.digest}`);
  let changed = 0;
  for (const file of stampedFiles()) {
    const before = readFileSync(file, "utf8");
    const after = restamp(before, stamp);
    if (after !== before) {
      writeFileSync(file, after);
      changed++;
    }
  }
  console.log(
    `stamped release ${stamp.release} (digest ${stamp.digest}) into ${changed} file(s); ` +
      "now re-read each summary against the served text before committing.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
