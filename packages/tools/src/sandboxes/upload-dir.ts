// Nested symlinks are skipped because their target can escape `dir` or loop; a
// symlinked `dir` itself is walked because the caller named it.
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
