// Package the desktop app into installers.
//
// electron-builder can't pack pnpm's isolated node_modules directly: workspace
// deps symlink to sibling packages/* and the store lives outside the app dir,
// but electron-builder requires every packed file under the app dir. So we
// first `pnpm deploy` into a throwaway dir — which materializes a self-contained
// node_modules whose symlinks all resolve INSIDE that dir — then run
// electron-builder there, writing artifacts back to <pkg>/release.
//
// Usage: node scripts/pack.mjs [--linux|--mac|--win]   (default --linux)
import { execFileSync } from "node:child_process";
import { cpSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // packages/harness-desktop
const repoRoot = dirname(dirname(pkgDir)); // sapiom-js
// realpath the tmp base: on macOS os.tmpdir() is `/var/folders/…`, a symlink to
// `/private/var/folders/…` (one level deeper). `pnpm deploy` writes the app
// package into `.pnpm/node_modules` as a RELATIVE symlink whose `../` count
// encodes the deploy dir's depth; electron-builder then realpaths the dir to
// the `/private` form (one level deeper), so that `../` chain lands one level
// short and the stat ENOENTs (`node_modules/.pnpm/node_modules/@sapiom/…`).
// Canonicalizing the base up front makes pnpm and electron-builder agree.
// No-op on Linux (`/tmp` isn't behind a symlink).
const deployDir = join(realpathSync(os.tmpdir()), "sapiom-harness-desktop-pack");
const outputDir = join(pkgDir, "release");
const platform = process.argv[2] ?? "--linux";
const isWindows = process.platform === "win32";

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
run(electronBuilder, [platform, `-c.directories.output=${outputDir}`], deployDir);

console.log(`[pack] done → ${outputDir}`);
