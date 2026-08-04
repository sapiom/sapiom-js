/**
 * This package's own version, read from its `package.json` at runtime.
 *
 * Read with `createRequire` rather than a static JSON import because
 * `tsconfig.json` sets `rootDir: "./src"` — importing a file outside that root
 * breaks the build even though `resolveJsonModule` is on. The relative path is
 * resolved from the compiled `dist/version.js`, so `../package.json` is the
 * package root either way.
 *
 * Its own module rather than a private helper of `analytics.ts`: the version is
 * not a telemetry concern (the feedback tool stamps it into `clientMeta`), and
 * a non-telemetry consumer importing the analytics module to get it would be a
 * puzzle for the next reader.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/** The `version` field of `@sapiom/mcp`'s package.json, or `"0.0.0"`. */
export function packageVersion(): string {
  try {
    const pkg = nodeRequire("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
