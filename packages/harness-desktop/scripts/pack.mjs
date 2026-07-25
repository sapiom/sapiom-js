// Package the desktop app into installers.
//
// electron-builder can't pack pnpm's isolated node_modules directly: workspace
// deps symlink to sibling packages/* and the store lives outside the app dir,
// but electron-builder requires every packed file under the app dir. So we
// first `pnpm deploy` into a throwaway dir — which materializes a self-contained
// node_modules whose symlinks all resolve INSIDE that dir — then run
// electron-builder there, writing artifacts back to <pkg>/release.
//
// Usage: node scripts/pack.mjs [--linux|--mac|--win] [...electron-builder args]
//   (defaults to the HOST platform; any further args pass through, e.g.
//   -c.mac.notarize=true)
import { execFileSync } from "node:child_process";
import { cpSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // packages/harness-desktop
const repoRoot = dirname(dirname(pkgDir)); // sapiom-js
const outputDir = join(pkgDir, "release");
/**
 * Default to the HOST platform, not a fixed one. CI always passes an explicit
 * flag (its whole point is cross-building a matrix), but a developer running
 * `pnpm dist` wants the artifact for the machine they're on — and cross-building
 * needs that platform's toolchain anyway, so a fixed default just fails. It
 * defaulted to `--linux`, which meant the documented local loop (`pnpm dist`
 * then `scripts/smoke.sh`) could not work on macOS: dist errored out, and smoke
 * then looked for a `release/mac-arm64/Sapiom.app` nothing had built.
 */
const HOST_PLATFORM_FLAG = { darwin: "--mac", win32: "--win" }[process.platform] ?? "--linux";
const platform = process.argv[2] ?? HOST_PLATFORM_FLAG;
// Anything after the platform flag goes straight to electron-builder. Signing
// and notarization are switched on this way (`-c.mac.notarize=true`) rather than
// hardcoded in electron-builder.yml, so a build without credentials still
// succeeds unsigned instead of failing.
// Empty strings filtered out: a shell passing an unset flag as "" would
// otherwise reach electron-builder as a bogus empty argument.
const passthrough = process.argv.slice(3).filter((arg) => arg.length > 0);
const isWindows = process.platform === "win32";

// Deploy-target base. `pnpm deploy` materializes the app's node_modules using
// RELATIVE symlinks, so the base must satisfy two constraints:
//  - POSIX: canonicalize os.tmpdir(). On macOS it's `/var/folders/…`, a symlink
//    to `/private/var/folders/…` (one level deeper); electron-builder later
//    realpaths the dir, so a non-canonical base makes the relative symlinks'
//    `../` chains land one level short → `ENOENT .pnpm/node_modules/@sapiom/…`.
//    No-op on Linux (`/tmp` isn't behind a symlink).
//  - Windows: the base must be on the SAME DRIVE as the repo. Relative paths
//    can't span drive letters on Windows, but GitHub runners check out to `D:`
//    while os.tmpdir() is on `C:` — a C: base corrupts the symlink targets
//    (`D:\…\harness-desktop\C:\Users\…`). Relocate to the repo's drive.
let tmpBase = realpathSync(os.tmpdir());
if (isWindows && tmpBase.slice(0, 2).toLowerCase() !== repoRoot.slice(0, 2).toLowerCase()) {
  tmpBase = join(`${repoRoot.slice(0, 2)}\\`, "sapiom-tmp");
}
const deployDir = join(tmpBase, "sapiom-harness-desktop-pack");

// On Windows, `pnpm`/`electron-builder` are `.cmd` shims. `execFileSync` can't
// resolve them (no PATHEXT lookup), and since CVE-2024-27980 Node refuses to
// spawn `.cmd`/`.bat` without `shell: true` at all. Run through the shell there
// so cmd.exe resolves the shim; a plain exec stays the default on POSIX. (CI
// runner paths have no spaces, so the shell's arg joining is safe here.)
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: isWindows });

console.log(`[pack] pnpm deploy → ${deployDir}`);
rmSync(deployDir, { recursive: true, force: true });
// --legacy: deploy without inject-workspace-packages (pnpm v10 default gate).
// --prod: drop devDeps (electron/electron-builder) — electronVersion is pinned
// in electron-builder.yml so the version is known without the devDep present.
run("pnpm", ["--filter", "@sapiom/harness-desktop", "deploy", "--prod", "--legacy", deployDir], repoRoot);

// `pnpm deploy` honors .gitignore, which excludes dist/ + release/. Copy the
// built app output, the builder config, and assets into the deploy dir.
cpSync(join(pkgDir, "dist"), join(deployDir, "dist"), { recursive: true });
cpSync(join(pkgDir, "electron-builder.yml"), join(deployDir, "electron-builder.yml"));
cpSync(join(pkgDir, "assets"), join(deployDir, "assets"), { recursive: true });

console.log(`[pack] electron-builder ${platform} → ${outputDir}`);
// The `.bin` entry is `electron-builder.cmd` on Windows, `electron-builder` on POSIX.
const electronBuilder = join(
  pkgDir,
  "node_modules",
  ".bin",
  isWindows ? "electron-builder.cmd" : "electron-builder",
);
run(electronBuilder, [platform, `-c.directories.output=${outputDir}`, ...passthrough], deployDir);

console.log(`[pack] done → ${outputDir}`);
