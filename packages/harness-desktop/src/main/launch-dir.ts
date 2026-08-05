/**
 * Which directory the desktop host opens the coding agent in — the launch dir.
 *
 * It is the STABLE scan root the rest of boot depends on: `startServer` derives
 * `projectRoot = <launchDir>/projects` (where every NEW agent is created) from
 * it, and the rail scans it recursively for agents. So it must stay pinned to
 * the harness home and must NOT drift into a project subfolder.
 *
 * Deriving it from the most-recent session dir (as boot once did, via
 * `settings.recentDirs`) broke exactly that invariant: sessions run *inside*
 * `projects/<agent>`, so on the next launch the launch dir became a project
 * folder and `<launchDir>/projects` nested every new agent one level deeper —
 * `projects/a/projects/b/projects/c/…` — compounding on every launch. Keeping
 * the launch dir at the harness home keeps all agents flat under one `projects/`
 * and lets the rail see every one of them. "Reopen where I left off" is a SPA
 * focus concern (which agent is selected), not a launch-dir one.
 *
 * The only escape hatch is an explicit `SAPIOM_LAUNCH_DIR` env override, for
 * dev/testing against a scratch workspace.
 */
export interface ResolveLaunchDirInput {
  /** `SAPIOM_LAUNCH_DIR` — an explicit dev/testing override (env var shape). */
  override?: string | undefined;
  /** The harness home (`~/.sapiom/harness`), the stable default. */
  harnessHome: string;
  /** Existence check for the override (injected so this stays pure/testable). */
  isDir: (p: string | undefined) => boolean;
}

/**
 * The launch dir: a valid `override` if one is set, otherwise always the
 * harness home. Deliberately never consults `recentDirs` — that is what caused
 * the nesting.
 */
export function resolveLaunchDir(input: ResolveLaunchDirInput): string {
  if (input.isDir(input.override)) return input.override as string;
  return input.harnessHome;
}
