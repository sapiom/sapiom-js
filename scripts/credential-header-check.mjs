#!/usr/bin/env node
/** Enforce shared credential transport for literal header writes (SAP-4106).
 * Exact-path exceptions must still match; see credential-header-allowlist.json. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const ALLOWLIST_PATH = path.join(
  SCRIPT_DIR,
  "credential-header-allowlist.json",
);

/** Exempt the shared owner because it must attach credentials after checking the channel. */
const OWNER = "packages/analytics-core/src/credential.ts";

const HEADER = String.raw`["'\x60]x-(?:sapiom-)?api-key["'\x60]`;
const FORBIDDEN = [
  new RegExp(String.raw`${HEADER}\s*:`, "gi"),
  new RegExp(String.raw`\[\s*${HEADER}\s*\]\s*=(?!=)`, "gi"),
  new RegExp(String.raw`\.(?:setHeader|set|append)\(\s*${HEADER}`, "gi"),
];

const SCANNED = /\.(?:ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "__tests__"]);

/** Preserve source line numbers so CI diagnostics point directly to matched header sites. */
export function findCredentialHeaderSites(text) {
  const lines = new Set();
  // Whole text, not line by line: a call's arguments may span lines.
  for (const re of FORBIDDEN) {
    for (const match of text.matchAll(re)) {
      lines.add(text.slice(0, match.index).split("\n").length);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

async function collect(root, dir, out) {
  for (const entry of await readdir(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const child = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await collect(root, child, out);
    } else if (SCANNED.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(child);
    }
  }
}

/** Exclude the shared owner so the guard audits consumers of the credential policy. */
export async function sourceFiles(root = REPOSITORY_ROOT) {
  const files = [];
  for (const pkg of await readdir(path.join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!pkg.isDirectory()) continue;
    const src = path.posix.join("packages", pkg.name, "src");
    try {
      await collect(root, src, files);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files.filter((file) => file !== OWNER).sort();
}

/** Reject unapproved header sites and obsolete exceptions so exemptions remain tied to matching files. */
export function audit(sources, allowlist) {
  const allowed = new Set(allowlist.map((entry) => entry.path));
  const matched = new Set();
  const violations = [];
  for (const { path: file, content } of sources) {
    const lines = findCredentialHeaderSites(content);
    if (lines.length === 0) continue;
    matched.add(file);
    if (!allowed.has(file)) {
      for (const line of lines) violations.push(`${file}:${line}`);
    }
  }
  const stale = allowlist.filter((entry) => !matched.has(entry.path));
  return { violations, stale };
}

export async function auditRepository(root = REPOSITORY_ROOT) {
  const allowlist = JSON.parse(await readFile(ALLOWLIST_PATH, "utf8"));
  const sources = await Promise.all(
    (await sourceFiles(root)).map(async (file) => ({
      path: file,
      content: await readFile(path.join(root, file), "utf8"),
    })),
  );
  return audit(sources, allowlist);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { violations, stale } = await auditRepository();
  for (const site of violations) {
    console.error(
      `${site}: sets the tenant key header by hand. Pass the key to ` +
        `credentialFetch from @sapiom/analytics-core/credential instead.`,
    );
  }
  for (const entry of stale) {
    console.error(
      `scripts/credential-header-allowlist.json: "${entry.id}" (${entry.path}) ` +
        `no longer sets the header; remove the entry.`,
    );
  }
  if (violations.length > 0 || stale.length > 0) process.exit(1);
  console.log("credential-header:check passed");
}
