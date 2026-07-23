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
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // packages/harness-desktop
const repoRoot = dirname(dirname(pkgDir)); // sapiom-js
const deployDir = join(os.tmpdir(), "sapiom-harness-desktop-pack");
const outputDir = join(pkgDir, "release");
const platform = process.argv[2] ?? "--linux";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

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
const electronBuilder = join(pkgDir, "node_modules", ".bin", "electron-builder");
run(electronBuilder, [platform, `-c.directories.output=${outputDir}`], deployDir);

console.log(`[pack] done → ${outputDir}`);
