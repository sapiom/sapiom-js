/**
 * `node` + `npm` shims backed by Electron-as-Node.
 *
 * A one-click desktop user may have NO system Node/npm — but the embedded
 * harness (and the coding agent) still shell out to `npm`/`node`: the sample
 * project's dependencies are installed with `npm install`, project tooling runs
 * under `node`, etc. Electron already bundles Node (reachable via
 * `process.execPath` + `ELECTRON_RUN_AS_NODE=1`) and we bundle the `npm`
 * package, so we materialize tiny `node`/`npm` shims in userData and prepend
 * their dir to PATH. Any child process the harness spawns then resolves a
 * working `node`/`npm` with zero system dependencies — and independent of where
 * (or whether) the user has their own (e.g. this box keeps them in /usr/sbin,
 * which a GUI app's minimal PATH misses).
 *
 * On Windows each CLI gets TWO files — `<name>.cmd` AND an extensionless
 * `#!/bin/sh` script — because Claude Code executes hook commands through Git
 * Bash there, and bash resolves only extensionless names/`.exe`, never `.cmd`.
 * npm itself ships three shim flavors (`.cmd`, `.ps1`, extensionless sh) for
 * exactly this reason. What bytes go in which file is `shim-files.ts`'s job
 * (pure, unit-tested); this module is only the electron-facing wiring.
 */
import { app } from "electron";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolveNpmBin } from "./agent-install.js";
import { shimFiles } from "./shim-files.js";

const isWindows = process.platform === "win32";

/** The dir the shims are written to (prepend this to PATH). */
export function shimDir(): string {
  return path.join(app.getPath("userData"), "runtime-bin");
}

/**
 * Write `node`/`npm` shims that re-enter this Electron binary as Node, and
 * return the dir to prepend to PATH. Idempotent — rewrites on every boot so the
 * shims track the current install location (userData is stable, but execPath
 * changes across app updates).
 */
export function installRuntimeShims(): string {
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });

  // node, npm AND npx. npx was the one missing, and its absence was silent: the
  // per-session MCP config launches the sapiom-dev server with `command: "npx"`
  // (`harness/src/core/inject/mcp-config.ts`), so on a machine with no system
  // Node that server simply never started and the agent quietly lacked every
  // Sapiom tool. The bundled npm package ships an `npx` bin, so this is the same
  // one-line shim as the other two — it just was not written.
  const clis: Array<[name: string, cli: string | null]> = [
    ["node", null],
    ["npm", resolveNpmBin("npm")],
    ["npx", resolveNpmBin("npx")],
  ];

  for (const file of shimFiles(process.execPath, process.platform, clis)) {
    const filePath = path.join(dir, file.fileName);
    writeFileSync(filePath, file.body);
    if (isWindows) {
      // chmod is a no-op on Windows but harmless — and never worth crashing
      // boot over on an exotic filesystem.
      try {
        chmodSync(filePath, 0o755);
      } catch {
        /* ignore */
      }
    } else {
      // POSIX: the execute bit is load-bearing; a failure here must surface.
      chmodSync(filePath, 0o755);
    }
  }
  return dir;
}
