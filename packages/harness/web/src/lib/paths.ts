/**
 * Browser-side path helpers for the ABSOLUTE paths the server hands us.
 *
 * The server builds them with `path.join`, so they arrive in the host's native
 * shape — backslash-separated on Windows. The SPA cannot ask `node:path` which
 * host that was; it infers the separator from the string itself, which works
 * because a Windows absolute path always contains at least one `\` (`C:\…`)
 * and a POSIX one never does.
 *
 * Joins preserve the input's native separator (what gets POSTed back must
 * match what the server sent), but every COMPARISON normalizes both
 * separators first: paths that were joined in the browser before this module
 * existed shipped in mixed form (`C:\Users\x\projects/newsletter-autopilot`),
 * and those still have to compare equal to their native spellings.
 */

/** The separator `p` itself uses. `\` anywhere marks a Windows path — POSIX
 *  filenames may legally contain `\`, but never in the absolute paths the
 *  server supplies. */
export function sepOf(p: string): "\\" | "/" {
  return p.includes("\\") ? "\\" : "/";
}

/** `<root><sep><name>` in the root's native separator, with no doubled
 *  separator when the root carries a trailing one. */
export function joinPath(root: string, name: string): string {
  const trimmedRoot = root.trim().replace(/[\\/]+$/, "");
  return `${trimmedRoot}${sepOf(root)}${name.trim()}`;
}

/** Last non-empty segment under either separator, or the input when it has
 *  none (a relative name is its own basename). */
export function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Parent of an absolute path, or null at a filesystem root (`/`, `C:\`, bare
 * `C:`) and for separator-free relative strings. Mirrors `path.dirname`
 * without pulling node:path into the browser bundle.
 *
 * Needed because GET /api/fs/list reports one level DOWN: a path can only
 * learn whether it is itself an agent project by asking its parent.
 */
export function parentOf(input: string): string | null {
  const trimmed = input.replace(/[\\/]+$/, "");
  if (trimmed === "" || /^[A-Za-z]:$/.test(trimmed)) return null;
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSep < 0) return null;
  const cut = trimmed.slice(0, lastSep);
  // First-level paths keep their root spelled out — `/Users` → `/`,
  // `C:\Users` → `C:\` — so the result is always itself a listable path.
  if (/^[A-Za-z]:$/.test(cut)) return cut + trimmed[lastSep];
  return cut || "/";
}

/** `/a/b/` → `/a/b` under either separator, so a user's trailing slash never
 *  breaks a path comparison. Bare roots (`/`, `C:\`) pass through unchanged —
 *  stripping them would leave something that isn't a path. */
export function stripTrailingSep(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (trimmed === p) return p;
  if (trimmed === "") return p[0];
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + p[trimmed.length];
  return trimmed;
}

/** Whether `child` IS `parent` or sits beneath it — never a mere string
 *  prefix, so `/a/scratch-2` is not within `/a/scratch`. Separator-insensitive
 *  on both sides, so a mixed-form path still matches its native spelling. */
export function isWithinDir(parent: string, child: string): boolean {
  const p = stripTrailingSep(parent.replace(/\\/g, "/"));
  const c = stripTrailingSep(child.replace(/\\/g, "/"));
  return c === p || c.startsWith(`${p}/`);
}

/** Whether typed input is trying to be an absolute path (`/…`, `~…`, or a
 *  Windows drive like `C:\…` / `C:/…`) rather than a search query. */
export function looksAbsolutePath(input: string): boolean {
  return input.startsWith("/") || input.startsWith("~") || /^[A-Za-z]:[\\/]/.test(input);
}

/** "/Users/…/onboarding-flow" — middle-truncates a long path so a chip row
 *  never hard-clips a chip mid-glyph; the full path stays in the tooltip. */
export function middleTruncatePath(path: string): string {
  const sep = sepOf(path);
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 2) return path;
  // POSIX first segments lost their leading `/` to the split; a drive letter
  // (`C:`) never had one.
  const prefix = sep === "\\" ? "" : sep;
  return `${prefix}${segments[0]}${sep}…${sep}${segments[segments.length - 1]}`;
}
