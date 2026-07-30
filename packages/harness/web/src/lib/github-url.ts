/**
 * Parse a GitHub repository URL (HTTPS or SSH) into its components.
 * Returns null for strings that do not match a known GitHub URL pattern.
 *
 * Accepted forms:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 */
export interface GitHubRepoRef {
  /** Repository owner (user or org). */
  owner: string;
  /** Repository name, without the trailing ".git". */
  repo: string;
  /** Normalised clone URL that can be passed directly to `git clone`. */
  cloneUrl: string;
}

const HTTPS_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/;
const SSH_RE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

/**
 * Parse a GitHub repository URL (HTTPS or SSH) and return its components, or
 * null when the input is not a recognisable GitHub URL.
 */
export function parseGitHubRepoUrl(raw: string): GitHubRepoRef | null {
  const trimmed = raw.trim();

  let owner: string | undefined;
  let repo: string | undefined;

  const httpsMatch = HTTPS_RE.exec(trimmed);
  if (httpsMatch) {
    owner = httpsMatch[1];
    repo = httpsMatch[2];
  } else {
    const sshMatch = SSH_RE.exec(trimmed);
    if (sshMatch) {
      owner = sshMatch[1];
      repo = sshMatch[2];
    }
  }

  if (!owner || !repo) return null;

  // Normalise to the tokenless HTTPS form — matches what we store in git config
  // after clone and is safe to pass to `git clone` for public or SSH-authed repos.
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Derive a sensible default target directory name from a parsed GitHub repo.
 * Returns just the repo name (the caller prepends the workspace root).
 */
export function defaultDirNameFor(ref: GitHubRepoRef): string {
  return ref.repo;
}
