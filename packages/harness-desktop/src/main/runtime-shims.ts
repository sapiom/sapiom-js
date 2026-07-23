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
import { resolveNpmCli } from "./agent-install.js";

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
  const npmCli = resolveNpmCli();

  if (isWindows) {
    // `%*` forwards args; ELECTRON_RUN_AS_NODE makes Electron behave as Node.
    writeFileSync(
      path.join(dir, "node.cmd"),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exec}" %*\r\n`,
    );
    writeFileSync(
      path.join(dir, "npm.cmd"),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exec}" "${npmCli}" %*\r\n`,
    );
    return dir;
  }

  const nodeShim = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${exec}" "$@"\n`;
  const npmShim = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${exec}" "${npmCli}" "$@"\n`;
  const nodePath = path.join(dir, "node");
  const npmPath = path.join(dir, "npm");
  writeFileSync(nodePath, nodeShim);
  writeFileSync(npmPath, npmShim);
  chmodSync(nodePath, 0o755);
  chmodSync(npmPath, 0o755);
  return dir;
}
