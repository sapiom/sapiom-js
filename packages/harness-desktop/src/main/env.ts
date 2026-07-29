/**
 * Environment fixups applied once, before `runDoctor()` / `startServer()`.
 *
 * Two unrelated things live here because they share that one requirement — both
 * mutate `process.env` so that everything downstream (the doctor, node-pty, the
 * in-process harness server) inherits the corrected value:
 *
 *   augmentProcessPath      — a GUI launch has no shell PATH (below)
 *   configureEsbuildBinary  — esbuild can't exec a binary inside app.asar
 *
 * ## PATH augmentation for a GUI-launched app
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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);

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
  // The Electron-as-Node shim dir goes LAST — a fallback for a machine with no
  // Node/npm at all. It must NOT shadow the user's real `node`: the agent runs
  // via `#!/usr/bin/env node`, and forcing it onto Electron-as-Node destabilizes
  // it and every subprocess it spawns. Real node/npm (found via the candidate
  // dirs or the inherited PATH) win; the shims only fill a genuine gap.
  const append = runtimeShimDir ? [runtimeShimDir] : [];
  const seen = new Set<string>();
  const merged = [...candidateBinDirs(agentBinDir), ...existing, ...append].filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
  const next = merged.join(sep);
  process.env.PATH = next;
  return next;
}

/**
 * Translate an `app.asar` path to its unpacked twin on disk. Electron patches
 * `fs` so a *read* through the virtual path works, but `spawn`, `cpSync`,
 * `opendir` and `chmod` go straight to the syscall and fail with `ENOTDIR` —
 * app.asar is a file, not a directory. Same transformation the harness applies
 * (`harness/src/core/canvas-manifest-check.ts`, `core/example-seed.ts`); it is a
 * no-op on an unpackaged build and on Windows, where we ship `asar: false`.
 */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

/**
 * esbuild's platform binary package + the subpath of the executable inside it,
 * mirroring esbuild's own `pkgAndSubpathForCurrentPlatform` for the platforms we
 * ship. Deliberately a small allow-list rather than a copy of esbuild's full
 * table: an unrecognized platform returns null and we leave esbuild to resolve
 * the binary itself, which is exactly today's behaviour.
 */
function esbuildPlatformPackage(): { pkg: string; subpath: string } | null {
  const key = `${process.platform}-${os.arch()}`;
  const supported = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ];
  if (!supported.includes(key)) return null;
  // Windows keeps the .exe at the package root; every other platform uses bin/.
  return { pkg: `@esbuild/${key}`, subpath: isWindows ? "esbuild.exe" : "bin/esbuild" };
}

/**
 * Point `ESBUILD_BINARY_PATH` at an esbuild binary that exists ON DISK.
 *
 * Why this is needed at all: `POST /api/workflows/:id/deploy` runs
 * agent-core's `bundleForDeploy()` **in-process** (`harness/src/server/actions.ts`),
 * and esbuild is not a JS bundler — it shells out to a native binary it locates
 * with `require.resolve`. Under Electron that hands back the virtual
 * `…/app.asar/node_modules/…/bin/esbuild` path, so the spawn dies with
 * `spawn ENOTDIR` and the user sees "Failed to bundle the agent for deploy.".
 * `asarUnpack` alone does NOT fix this: the file lands on disk, but every path
 * derived from `require.resolve` still names the archive.
 *
 * esbuild honours this env var before doing any resolution of its own
 * (`esbuild/lib/main.js`, `generateBinPath`), so setting it here fixes deploy and
 * any future in-process esbuild caller in one place — no patching of a
 * dependency's internals, and nothing about Electron leaking into agent-core
 * (a published SDK that has no business knowing what app.asar is).
 *
 * Fail-soft by construction: an unknown platform, a failed resolve, or a missing
 * file all return null and leave the variable unset, which is precisely the
 * behaviour we have today. Never overrides a value already set — that is
 * someone deliberately pinning a binary.
 *
 * @returns the path it set, or null if it left the environment untouched.
 */
export function configureEsbuildBinary(): string | null {
  if ((process.env.ESBUILD_BINARY_PATH ?? "").trim() !== "") return null;

  const platform = esbuildPlatformPackage();
  if (!platform) return null;

  let binPath: string;
  try {
    // Walk the same chain the harness does at runtime. esbuild is a TRANSITIVE
    // dependency (harness → agent-core → esbuild) and pnpm's isolated
    // node_modules make it invisible from this package, so resolving it from
    // here would work in a hoisted tree and fail in the one we ship.
    const fromHarness = createRequire(require.resolve("@sapiom/harness/package.json"));
    const fromAgentCore = createRequire(fromHarness.resolve("@sapiom/agent-core"));
    const fromEsbuild = createRequire(fromAgentCore.resolve("esbuild/package.json"));
    binPath = unpackedPath(fromEsbuild.resolve(`${platform.pkg}/${platform.subpath}`));
  } catch {
    return null;
  }
  if (!existsSync(binPath)) return null;

  process.env.ESBUILD_BINARY_PATH = binPath;
  return binPath;
}
