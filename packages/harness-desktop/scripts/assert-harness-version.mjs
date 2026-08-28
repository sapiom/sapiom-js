import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertHarnessVersion,
  HAS_PINNED_HARNESS,
} from "./harness-version.mjs";

const require = createRequire(import.meta.url);

// With no explicit pin, Desktop is back in its normal workspace-development
// mode. Build the Harness before resolving it so Electron cannot boot a stale
// dist/ tree. An explicit manifest argument is test/check mode and never builds.
if (!HAS_PINNED_HARNESS && process.argv[2] === undefined) {
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
  process.argv[2] ?? require.resolve("@sapiom/harness/package.json");

assertHarnessVersion(manifestPath, "desktop development dependency");
