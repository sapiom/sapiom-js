/**
 * PATH augmentation for a GUI-launched app.
 *
 * A double-clicked app (Finder / .desktop / Start menu) inherits a minimal
 * environment — NOT the user's shell PATH from `.zshrc`/`.bashrc`. So the
 * harness's `runDoctor()` (`which claude` / `where claude`) and the node-pty
 * process it spawns would fail to find `claude`/`codex`/`git` even when they
 * are installed. We rebuild a sane PATH and set `process.env.PATH` BEFORE
 * `runDoctor()` and `startServer()` so both detection and PTY spawns resolve.
 *
 * node-pty inherits `process.env` at spawn time, so mutating `process.env.PATH`
 * here is what makes the auto-installed agent (Phase 3) discoverable too.
 */
import * as os from "node:os";
import * as path from "node:path";

const isWindows = process.platform === "win32";

/** Common user/global bin locations that a GUI app misses. */
function candidateBinDirs(agentBinDir: string): string[] {
  const home = os.homedir();
  if (isWindows) {
    // npm global shims land directly in the prefix root on Windows.
    return [
      agentBinDir,
      path.join(home, "AppData", "Roaming", "npm"),
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs"),
    ];
  }
  return [
    agentBinDir,
    "/usr/local/bin",
    "/opt/homebrew/bin", // macOS Apple Silicon Homebrew
    "/usr/bin",
    "/bin",
    "/usr/sbin", // some setups keep node/npm here (this dev box does)
    "/sbin",
    path.join(home, ".local", "bin"), // where `claude` often installs (and does on this box)
    path.join(home, ".npm-global", "bin"),
  ];
}

/**
 * Prepend our known bin dirs (deduped, existing-or-not — cheap) to PATH and
 * write it back to `process.env.PATH`. `agentBinDir` is the bin dir of the
 * app-controlled npm --prefix install target (Phase 3); pass it so a freshly
 * auto-installed `claude` is found on the same launch.
 */
export function augmentProcessPath(agentBinDir: string, runtimeShimDir?: string): string {
  const sep = isWindows ? ";" : ":";
  const existing = (process.env.PATH ?? "").split(sep).filter(Boolean);
  // The Electron-as-Node shim dir goes FIRST so `node`/`npm` resolve to the
  // bundled runtime regardless of what (if anything) the user has installed.
  const prepend = [...(runtimeShimDir ? [runtimeShimDir] : []), ...candidateBinDirs(agentBinDir)];
  const seen = new Set<string>();
  const merged = [...prepend, ...existing].filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
  const next = merged.join(sep);
  process.env.PATH = next;
  return next;
}
