#!/usr/bin/env node
/**
 * Fails when SDK source sets the tenant key header (`x-api-key` /
 * `x-sapiom-api-key`) by hand instead of passing the key to `credentialFetch`
 * from `@sapiom/analytics-core/credential`, the one place that checks the
 * channel and drops the key on a cross-origin redirect (SAP-4106).
 *
 * It reads literals only: a header name held in a variable, or the key sent as
 * `Authorization: Bearer`, passes. An allowlist entry exempts one file by exact
 * path; an entry whose file no longer matches fails too, so the list only shrinks.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const ALLOWLIST_PATH = path.join(
  SCRIPT_DIR,
  "credential-header-allowlist.json",
);

/** The shared module itself: it is where the header is set. */
const OWNER = "packages/analytics-core/src/credential.ts";

const HEADER = String.raw`["'\x60]x-(?:sapiom-)?api-key["'\x60]`;
const FORBIDDEN = [
  // { "x-api-key": key }
  new RegExp(String.raw`${HEADER}\s*:`, "i"),
  // headers["x-api-key"] = key
  new RegExp(String.raw`\[\s*${HEADER}\s*\]\s*=(?!=)`, "i"),
  // headers.set("x-api-key", key), req.setHeader(...), headers.append(...)
  new RegExp(String.raw`\.(?:setHeader|set|append)\(\s*${HEADER}`, "i"),
];

const SCANNED = /\.(?:ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "__tests__"]);

/** 1-based line numbers where `text` sets a credential header by hand. */
export function findCredentialHeaderSites(text) {
  const lines = [];
  text.split("\n").forEach((line, i) => {
    if (FORBIDDEN.some((re) => re.test(line))) lines.push(i + 1);
  });
  return lines;
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

/** Every non-test source file under `packages/*\/src`. */
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

/**
 * `sources`: `{ path, content }[]`. `allowlist`: `{ id, path, ticket }[]`.
 * Returns the violations (`path:line`) and the stale allowlist entries.
 */
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
