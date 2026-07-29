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
 */
import { app } from "electron";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolveNpmBin } from "./agent-install.js";

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
  const exec = process.execPath;

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

  for (const [name, cli] of clis) {
    if (isWindows) {
      // `%*` forwards args; ELECTRON_RUN_AS_NODE makes Electron behave as Node.
      const body = cli
        ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exec}" "${cli}" %*\r\n`
        : `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exec}" %*\r\n`;
      writeFileSync(path.join(dir, `${name}.cmd`), body);
      continue;
    }
    const body = cli
      ? `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${exec}" "${cli}" "$@"\n`
      : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${exec}" "$@"\n`;
    const shimPath = path.join(dir, name);
    writeFileSync(shimPath, body);
    chmodSync(shimPath, 0o755);
  }
  return dir;
}
