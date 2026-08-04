/**
 * Where a NEW agent project goes, and what it is called.
 *
 * Both add-workspace doors that create a project ("start from a template" and
 * "start from an idea") need to answer the same two questions before any
 * session exists, and they must never disagree. This module is that shared
 * answer.
 *
 * Why a folder is unavoidable, and why the name has to be decided up front:
 *   - a session is a PTY with a `cwd`, and scaffolding is "start a session in a
 *     folder, then ask the agent to call `sapiom_dev_agents_scaffold`";
 *   - `scaffold()` refuses user content in the target (agent-core
 *     `DIR_NOT_EMPTY`) while allowing Studio's own `.sapiom/` state;
 *   - `projectName` defaults to `basename(targetDir)` and is stamped into
 *     `package.json` "name" and `defineAgent({ name })`.
 *
 * That last point makes naming load-bearing rather than cosmetic: an invalid
 * name lands in package.json and breaks `npm install` inside the fresh
 * scaffold. Hence `isValidProjectName` gates submission.
 *
 * Everything here is pure and synchronous on purpose — it runs on every
 * keystroke AND before any session exists, which is exactly why nothing
 * smarter (an LLM naming the project from the idea) can do this job.
 *
 * Design: plans/harness-idea-door/design.md in the Sapiom repo.
 */

/**
 * A legal npm package name, restricted to the subset that is also a sane
 * directory name: lowercase alphanumerics and dashes, starting alphanumeric.
 * npm's own cap is 214 characters.
 */
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,213}$/;

/** Fallback when an idea yields nothing usable — matches the blank starter's folder. */
export const FALLBACK_PROJECT_NAME = "sapiom-agent";

/** How many idea words survive into the name, and its length budget. */
const NAME_WORD_BUDGET = 3;
const NAME_CHAR_BUDGET = 32;

/**
 * Filler that carries no identity. Dropped so "Every morning, diff our
 * competitors' pricing" becomes `diff-competitors-pricing` rather than
 * `every-morning-diff`. Cadence words go too — the schedule is not the agent.
 */
const IDEA_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "can", "could", "do", "each",
  "every", "for", "from", "get", "i", "if", "in", "into", "is", "it", "its", "just",
  "me", "my", "need", "of", "on", "once", "or", "our", "please", "should", "so",
  "that", "the", "their", "them", "then", "there", "this", "to", "us", "want",
  "we", "when", "with", "would", "you", "your",
  // cadence
  "daily", "day", "hourly", "hour", "week", "weekly", "month", "monthly",
  "morning", "evening", "night", "always", "regularly",
]);

/** Whether a name is safe to use as both a folder name and a package name. */
export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name);
}

/**
 * Derive a project name from an idea. Never throws and never returns something
 * `isValidProjectName` would reject — a caller can always use the result.
 */
export function slugifyIdea(idea: string): string {
  const words = idea
    .toLowerCase()
    // Everything non-alphanumeric becomes a separator, so punctuation,
    // emoji and scripts we can't transliterate all fall away rather than
    // producing an invalid name.
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

  // Stopwords are dropped, but not if that would leave nothing: "every day"
  // is a poor name and yet better than the generic fallback.
  const meaningful = words.filter((word) => !IDEA_STOPWORDS.has(word));
  const source = meaningful.length > 0 ? meaningful : words;

  // Accumulate whole words up to the char budget rather than slicing and
  // trimming a trailing dash — truncation lands on a word boundary by
  // construction, and a single over-long word still yields a valid name.
  const parts: string[] = [];
  for (const word of source.slice(0, NAME_WORD_BUDGET)) {
    const candidate = parts.length === 0 ? word : `${parts.join("-")}-${word}`;
    if (candidate.length > NAME_CHAR_BUDGET) break;
    parts.push(word);
  }

  const slug = parts.join("-") || source[0]?.slice(0, NAME_CHAR_BUDGET) || "";
  return isValidProjectName(slug) ? slug : FALLBACK_PROJECT_NAME;
}

/**
 * `<root>/<name>` with no double slashes. Returns "" when either side is
 * missing, matching `templateDirSuggestion`'s existing contract for a null
 * launch dir (the caller renders nothing rather than a half path).
 */
export function projectDirSuggestion(name: string, root: string | null): string {
  const trimmedRoot = root?.trim().replace(/\/+$/, "") ?? "";
  const trimmedName = name.trim();
  if (!trimmedRoot || !trimmedName) return "";
  return `${trimmedRoot}/${trimmedName}`;
}

/**
 * Where new projects live. Precedence:
 *   1. the user's saved `projectRoot` setting
 *   2. the host's default (server-supplied: `<launchDir>/projects` under
 *      Electron, plain `launchDir` for the CLI)
 *   3. `launchDir`
 *
 * Kept as an explicit chain rather than a host sniff: the SERVER knows which
 * host it is running under, so the browser never has to guess.
 */
export function resolveProjectRoot(input: {
  settingsRoot?: string | null;
  defaultProjectRoot?: string | null;
  launchDir?: string | null;
}): string {
  return (
    input.settingsRoot?.trim() ||
    input.defaultProjectRoot?.trim() ||
    input.launchDir?.trim() ||
    ""
  );
}

/**
 * Parent of an absolute path, or null at the filesystem root. Mirrors
 * `path.dirname` without pulling node:path into the browser bundle.
 *
 * Needed because GET /api/fs/list reports one level DOWN: a path can only learn
 * whether it is itself an agent project by asking its parent.
 */
export function parentOf(input: string): string | null {
  const trimmed = input.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const cut = trimmed.slice(0, lastSlash);
  if (cut === trimmed) return null;
  return cut || "/";
}

/**
 * First name in the `base`, `base-2`, `base-3`, … series that isn't taken.
 *
 * Only ever applied to a SUGGESTION. A name the user typed is never silently
 * altered — it is reported as colliding and submission is blocked, because
 * `scaffold()` would refuse the non-empty directory anyway and a silent
 * redirect to a different folder is worse than an error.
 */
export function nextAvailableName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate) && isValidProjectName(candidate)) return candidate;
  }
  return base;
}
