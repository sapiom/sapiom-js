/**
 * install-deps — best-effort `npm install` for a freshly-scaffolded (or
 * freshly-cloned) agent project.
 *
 * Why this is its own module: the Canvas step-graph extraction (`check()`)
 * esbuild-bundles the project's `index.ts` and resolves its imports —
 * `@sapiom/agent`, `zod`, … — from the project's own `node_modules`. A project
 * whose deps were never installed therefore fails its very first Canvas render
 * with "Could not resolve …". Running the install as part of create/seed means
 * a new agent opens with a working Canvas instead of an error the user has to
 * ask their coding agent to fix.
 *
 * Deliberately best-effort and non-fatal: if npm is missing or offline the
 * caller still succeeds, and the Canvas degrades to its existing "run
 * npm install / ask your agent to fix it" prompt (see describeBundleFailure).
 */
import { execFileSync } from "node:child_process";

/** Hard ceiling on the install so a pathological dependency tree can't block a
 *  scaffold/seed indefinitely. */
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Run `npm install` in `projectDir`. Returns true on success, false on any
 * failure (npm missing, offline, non-zero exit, timeout) — never throws, so a
 * caller can treat a failed install as a soft degrade rather than a hard error.
 *
 * `shell: true` on Windows lets the OS resolve the `npm.cmd` shim; `cwd` (which
 * may contain spaces) is passed via options, not interpolated into a command
 * line, so it stays safe.
 */
export function installProjectDependencies(projectDir: string): boolean {
  try {
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--loglevel=error"],
      {
        cwd: projectDir,
        stdio: "ignore",
        shell: process.platform === "win32",
        timeout: INSTALL_TIMEOUT_MS,
      },
    );
    return true;
  } catch {
    return false;
  }
}
