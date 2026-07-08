/**
 * PATH-based executable detection: the pure-Node lookup helper under
 * manipulated PATH/PATHEXT environments (POSIX and emulated Windows
 * rules), and the adapters' detectInstalled() built on top of it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findExecutableOnPath } from "../detect.js";
import { claudeCodeAdapter } from "../claude-code.js";
import { codexAdapter } from "../codex.js";
import { opencodeAdapter } from "../opencode.js";
import { piAdapter } from "../pi.js";

const onPosix = process.platform !== "win32";
const itPosix = onPosix ? it : it.skip;

let tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "harness-detect-")),
  );
  tmpDirs.push(dir);
  return dir;
}

function writeBin(dir: string, name: string, mode = 0o755): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode });
  return file;
}

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("findExecutableOnPath (POSIX rules)", () => {
  itPosix("finds an executable file on PATH", async () => {
    const dir = tmpDir();
    const file = writeBin(dir, "claude");

    await expect(
      findExecutableOnPath("claude", { env: { PATH: dir } }),
    ).resolves.toBe(file);
  });

  itPosix("honors PATH order — the first match wins", async () => {
    const first = tmpDir();
    const second = tmpDir();
    const expected = writeBin(first, "claude");
    writeBin(second, "claude");

    await expect(
      findExecutableOnPath("claude", {
        env: { PATH: `${first}:${second}` },
      }),
    ).resolves.toBe(expected);
  });

  itPosix("skips files without the execute bit", async () => {
    const dir = tmpDir();
    writeBin(dir, "claude", 0o644);

    await expect(
      findExecutableOnPath("claude", { env: { PATH: dir } }),
    ).resolves.toBeNull();
  });

  itPosix("skips directories that merely share the name", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "claude"));

    await expect(
      findExecutableOnPath("claude", { env: { PATH: dir } }),
    ).resolves.toBeNull();
  });

  it("returns null when the binary is absent", async () => {
    const dir = tmpDir();
    await expect(
      findExecutableOnPath("claude", { env: { PATH: dir } }),
    ).resolves.toBeNull();
  });

  it("returns null for a missing or empty PATH", async () => {
    await expect(
      findExecutableOnPath("claude", { env: {} }),
    ).resolves.toBeNull();
    await expect(
      findExecutableOnPath("claude", { env: { PATH: "" } }),
    ).resolves.toBeNull();
  });

  it("skips empty PATH segments instead of searching the current directory", async () => {
    const dir = tmpDir();
    await expect(
      findExecutableOnPath("claude", { env: { PATH: `:${dir}:` } }),
    ).resolves.toBeNull();
  });
});

describe("findExecutableOnPath (Windows rules, emulated)", () => {
  it("resolves binaries via PATHEXT", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "claude.CMD");
    fs.writeFileSync(file, "@echo off\r\n"); // note: no execute bit needed

    await expect(
      findExecutableOnPath("claude", {
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        platform: "win32",
      }),
    ).resolves.toBe(file);
  });

  it("falls back to the OS default PATHEXT when unset", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "claude.EXE");
    fs.writeFileSync(file, "");

    await expect(
      findExecutableOnPath("claude", {
        env: { PATH: dir },
        platform: "win32",
      }),
    ).resolves.toBe(file);
  });

  it("matches a name that already carries an extension as-is", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "claude.cmd");
    fs.writeFileSync(file, "@echo off\r\n");

    await expect(
      findExecutableOnPath("claude.cmd", {
        env: { PATH: dir, PATHEXT: ".EXE" },
        platform: "win32",
      }),
    ).resolves.toBe(file);
  });

  it("does not match a bare extensionless file", async () => {
    const dir = tmpDir();
    writeBin(dir, "claude"); // executable, but no PATHEXT extension

    await expect(
      findExecutableOnPath("claude", {
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        platform: "win32",
      }),
    ).resolves.toBeNull();
  });

  it("splits PATH on the Windows delimiter", async () => {
    const first = tmpDir();
    const second = tmpDir();
    const file = path.join(second, "claude.EXE");
    fs.writeFileSync(file, "");

    await expect(
      findExecutableOnPath("claude", {
        env: { PATH: `${first};${second}`, PATHEXT: ".EXE" },
        platform: "win32",
      }),
    ).resolves.toBe(file);
  });
});

// Adapters read the real process environment, so these tests swap PATH
// out and restore it afterwards. Jest runs test files in isolated
// processes, so this cannot leak into other suites.
(onPosix ? describe : describe.skip)(
  "adapter detectInstalled() under a manipulated PATH",
  () => {
    const ORIGINAL_PATH = process.env.PATH;

    afterEach(() => {
      process.env.PATH = ORIGINAL_PATH;
    });

    const CASES = [
      ["claude-code", claudeCodeAdapter, "claude"],
      ["codex", codexAdapter, "codex"],
      ["pi", piAdapter, "pi"],
      ["opencode", opencodeAdapter, "opencode"],
    ] as const;

    it.each(CASES)(
      "%s: true when its binary is on PATH",
      async (_id, adapter, binary) => {
        const dir = tmpDir();
        writeBin(dir, binary);
        process.env.PATH = dir;

        await expect(adapter.detectInstalled()).resolves.toBe(true);
      },
    );

    it.each(CASES)(
      "%s: false when PATH has no such binary",
      async (_id, adapter, _binary) => {
        process.env.PATH = tmpDir(); // empty directory

        await expect(adapter.detectInstalled()).resolves.toBe(false);
      },
    );

    it("other adapters' binaries do not cause a false positive", async () => {
      const dir = tmpDir();
      writeBin(dir, "codex");
      process.env.PATH = dir;

      await expect(claudeCodeAdapter.detectInstalled()).resolves.toBe(false);
      await expect(codexAdapter.detectInstalled()).resolves.toBe(true);
    });
  },
);
