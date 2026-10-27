/**
 * Collect the files to upload from a local directory for a preview deploy.
 *
 * Walks `dir` and returns `{ path, content }[]` with POSIX-relative paths. Always
 * skips `node_modules`, `.git`, and dotfiles/dot-dirs (dependencies install in the
 * sandbox — never uploaded). Extra `ignore` patterns match by exact path, path
 * prefix (`dir/`), name segment, or suffix (`*.log`).
 *
 * Symlinks inside the tree are skipped, not followed: a link's target can sit
 * outside `dir` (and a preview can be public), and a self-referential link would
 * recurse forever. `dir` itself may be a symlink: it is the path the caller named.
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  existsSync,
} from "node:fs";
import path from "node:path";

export interface CollectedFile {
  /** POSIX path relative to the walked directory. */
  path: string;
  /** UTF-8 file contents. */
  content: string;
}

const ALWAYS_SKIP = new Set(["node_modules", ".git"]);

function isIgnored(relPath: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.endsWith("/")) return relPath.startsWith(p) || relPath.includes(`/${p}`);
    if (p.startsWith("*")) return relPath.endsWith(p.slice(1));
    return relPath === p || relPath.startsWith(`${p}/`) || relPath.split("/").includes(p);
  });
}

/** Collect deployable files under `dir` (UTF-8 text; binary assets out of scope). */
export function collectDirFiles(dir: string, ignore: string[] = []): CollectedFile[] {
  const root = path.resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Directory not found: ${root}`);
  }
  const files: CollectedFile[] = [];

  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      if (ALWAYS_SKIP.has(entry) || entry.startsWith(".")) continue;
      const childAbs = path.join(abs, entry);
      const rel = path.relative(root, childAbs).split(path.sep).join("/");
      if (isIgnored(rel, ignore)) continue;
      const stat = lstatSync(childAbs);
      if (stat.isDirectory()) {
        walk(childAbs);
      } else if (stat.isFile()) {
        files.push({ path: rel, content: readFileSync(childAbs, "utf8") });
      }
    }
  };

  walk(root);
  return files;
}
