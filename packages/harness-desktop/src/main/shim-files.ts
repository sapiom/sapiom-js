/**
 * Pure shim-file generation for `runtime-shims.ts` — what files to write, with
 * what bytes, for a given platform. No `electron` import, so `vitest` can pin
 * the exact shim bodies (see vitest.config.ts).
 *
 * On POSIX one extensionless `#!/bin/sh` script per CLI is enough. On Windows
 * it is NOT: consumers resolve commands in two incompatible ways, so we ship
 * TWO flavors per CLI, the same way npm itself ships THREE (`<name>.cmd`,
 * `<name>.ps1`, and an extensionless POSIX sh script for Git Bash):
 *
 * - `<name>.cmd` — for cmd.exe/PowerShell-style resolution (PATHEXT). This is
 *   what `where` finds and what `spawn-target.ts`-style shim resolution runs.
 * - `<name>` (extensionless, `#!/bin/sh`, LF) — for Git Bash. Claude Code
 *   executes hook commands through Git Bash on Windows, and bash resolves only
 *   extensionless names or `.exe` — never `.cmd`. Without this file, the
 *   generated SessionStart hook (`node "<emit.cjs>" …`) dies on a machine with
 *   no system Node, and sessions never reach "ready".
 *
 * The sh shim's embedded paths are written with FORWARD slashes: Git Bash and
 * the Win32 API both accept them, while a backslash inside sh double quotes is
 * an escaping bug waiting to happen (`\U`, `\n`, …).
 */

export interface ShimFile {
  fileName: string;
  body: string;
}

/** `#!/bin/sh` body: re-enter the Electron binary as Node. */
function shBody(execPath: string, cli: string | null): string {
  return cli
    ? `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${execPath}" "${cli}" "$@"\n`
    : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${execPath}" "$@"\n`;
}

/** `.cmd` body: `%*` forwards args; ELECTRON_RUN_AS_NODE makes Electron behave as Node. */
function cmdBody(execPath: string, cli: string | null): string {
  return cli
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${cli}" %*\r\n`
    : `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`;
}

/** Backslashes → forward slashes, for paths embedded in sh double quotes. */
function forwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * The shim files to materialize for `clis` on `platform`. Each entry of `clis`
 * is `[name, cliPath]` where a `null` cliPath means "Electron-as-Node itself"
 * (the `node` shim) and a path means "run this JS entry" (npm/npx).
 */
export function shimFiles(
  execPath: string,
  platform: NodeJS.Platform,
  clis: Array<[name: string, cli: string | null]>,
): ShimFile[] {
  const files: ShimFile[] = [];
  for (const [name, cli] of clis) {
    if (platform === "win32") {
      files.push({ fileName: `${name}.cmd`, body: cmdBody(execPath, cli) });
      files.push({
        fileName: name,
        body: shBody(forwardSlashes(execPath), cli === null ? null : forwardSlashes(cli)),
      });
      continue;
    }
    files.push({ fileName: name, body: shBody(execPath, cli) });
  }
  return files;
}
