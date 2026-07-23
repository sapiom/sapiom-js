/**
 * Path resolution for embedded assets. Kept explicit (not relying on the
 * harness's internal `packageRoot()` `import.meta.url` guess) so it survives
 * asar packaging: `createRequire(...).resolve("@sapiom/harness/package.json")`
 * returns the real (unpacked-if-needed) location under Electron.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const mainDir = path.dirname(fileURLToPath(import.meta.url)); // .../dist/main

/** The built harness SPA served by startServer (`@sapiom/harness/dist/web`). */
export function resolveWebDir(): string {
  const harnessPkgJson = require.resolve("@sapiom/harness/package.json");
  return path.join(path.dirname(harnessPkgJson), "dist", "web");
}

/** This app's setup-window HTML (copied to dist/renderer by the build). */
export function setupHtmlPath(): string {
  return path.join(mainDir, "..", "renderer", "setup.html");
}

/** This app's preload script for the setup window. */
export function setupPreloadPath(): string {
  return path.join(mainDir, "..", "preload", "setup.js");
}
