/**
 * Pin the exact bytes of the runtime shims (see shim-files.ts / runtime-shims.ts).
 *
 * Two flavors matter on Windows: the `.cmd` for PATHEXT-style resolution
 * (cmd.exe, `where`, spawn-target's shim resolution) and the extensionless
 * `#!/bin/sh` script for Git Bash — Claude Code runs hook commands through Git
 * Bash there, and bash never resolves `.cmd`, so without the sh flavor the
 * generated SessionStart hook's `node …` dies on a machine with no system Node
 * and sessions never reach "ready".
 */
import { describe, expect, it } from "vitest";

import { shimFiles, type ShimFile } from "./shim-files.js";

const WIN_EXEC = "C:\\Users\\x\\AppData\\Local\\Programs\\Sapiom\\Sapiom.exe";
const WIN_NPM_CLI = "C:\\Users\\x\\AppData\\Local\\Programs\\Sapiom\\resources\\npm\\bin\\npm-cli.js";
const WIN_NPX_CLI = "C:\\Users\\x\\AppData\\Local\\Programs\\Sapiom\\resources\\npm\\bin\\npx-cli.js";

function byName(files: ShimFile[], name: string): ShimFile {
  const file = files.find((f) => f.fileName === name);
  if (!file) throw new Error(`missing shim file ${name}`);
  return file;
}

describe("shimFiles on win32", () => {
  const files = shimFiles(WIN_EXEC, "win32", [
    ["node", null],
    ["npm", WIN_NPM_CLI],
    ["npx", WIN_NPX_CLI],
  ]);

  it("writes exactly two files per cli: <name>.cmd and extensionless <name>", () => {
    expect(files.map((f) => f.fileName).sort()).toEqual(
      ["node", "node.cmd", "npm", "npm.cmd", "npx", "npx.cmd"].sort(),
    );
  });

  it("node.cmd keeps the exact pre-existing format: CRLF, %*, ELECTRON_RUN_AS_NODE, backslash path", () => {
    expect(byName(files, "node.cmd").body).toBe(
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${WIN_EXEC}" %*\r\n`,
    );
  });

  it("npm.cmd / npx.cmd carry the cli path between execPath and %*", () => {
    expect(byName(files, "npm.cmd").body).toBe(
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${WIN_EXEC}" "${WIN_NPM_CLI}" %*\r\n`,
    );
    expect(byName(files, "npx.cmd").body).toBe(
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${WIN_EXEC}" "${WIN_NPX_CLI}" %*\r\n`,
    );
  });

  it("extensionless node is a #!/bin/sh script with a forward-slash execPath and \"$@\", LF only", () => {
    expect(byName(files, "node").body).toBe(
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "C:/Users/x/AppData/Local/Programs/Sapiom/Sapiom.exe" "$@"\n`,
    );
  });

  it("extensionless npm/npx forward-slash the cli path too", () => {
    expect(byName(files, "npm").body).toBe(
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "C:/Users/x/AppData/Local/Programs/Sapiom/Sapiom.exe" "C:/Users/x/AppData/Local/Programs/Sapiom/resources/npm/bin/npm-cli.js" "$@"\n`,
    );
    expect(byName(files, "npx").body).toBe(
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "C:/Users/x/AppData/Local/Programs/Sapiom/Sapiom.exe" "C:/Users/x/AppData/Local/Programs/Sapiom/resources/npm/bin/npx-cli.js" "$@"\n`,
    );
  });

  it("sh bodies contain no backslash and no CR (escaping bugs inside sh double quotes)", () => {
    for (const name of ["node", "npm", "npx"]) {
      expect(byName(files, name).body).not.toContain("\\");
      expect(byName(files, name).body).not.toContain("\r");
    }
  });
});

describe("shimFiles on POSIX", () => {
  const exec = "/Applications/Sapiom.app/Contents/MacOS/Sapiom";
  const npmCli = "/Applications/Sapiom.app/Contents/Resources/npm/bin/npm-cli.js";

  it("is unchanged from the pre-split behavior: one extensionless sh shim per cli", () => {
    const files = shimFiles(exec, "darwin", [
      ["node", null],
      ["npm", npmCli],
    ]);
    expect(files.map((f) => f.fileName)).toEqual(["node", "npm"]);
    expect(byName(files, "node").body).toBe(
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${exec}" "$@"\n`,
    );
    expect(byName(files, "npm").body).toBe(
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${exec}" "${npmCli}" "$@"\n`,
    );
  });

  it("linux matches darwin (any non-win32 platform takes the POSIX branch)", () => {
    expect(shimFiles(exec, "linux", [["node", null]])).toEqual(
      shimFiles(exec, "darwin", [["node", null]]),
    );
  });
});
