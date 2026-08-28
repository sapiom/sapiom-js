import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertHarnessVersion,
  HAS_PINNED_HARNESS,
} from "./harness-version.mjs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const buildWorkspace = args[0] === "--build";

if (args.length > 1 || (buildWorkspace && args.length !== 1)) {
  throw new Error(
    "usage: assert-harness-version.mjs [--build | manifest-path]",
  );
}

// `dev` opts into preparation with --build. Resolution checks (including the
// no-argument installed-package test) stay side-effect free, so removing the
// temporary pin cannot turn the unit suite into a recursive workspace build.
if (buildWorkspace && !HAS_PINNED_HARNESS) {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoRoot = dirname(dirname(packageDir));
  execFileSync("pnpm", ["--filter", "@sapiom/harness...", "build"], {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
    windowsHide: true,
  });
}

const manifestPath =
  (buildWorkspace ? undefined : args[0]) ??
  require.resolve("@sapiom/harness/package.json");

assertHarnessVersion(manifestPath, "desktop development dependency");
