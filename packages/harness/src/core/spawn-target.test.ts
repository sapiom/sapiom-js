/**
 * The Windows spawn path was invisible to every tier we had: the mock-mode e2e
 * never touches a server, the integration tests inject a fake `spawnPty` (so they
 * never reach CreateProcess), and CI ran the real thing on Linux only. Every
 * dependency here is injected precisely so that path is asserted from Linux.
 *
 * The adversarial-argument cases are the point of the whole design: an earlier
 * version of this module wrapped spawns in `cmd.exe /d /s /c`, which meant an
 * argument containing a quote plus `&` could execute a second command (node-pty
 * escapes `"` as `\"` for CreateProcess, but cmd.exe only counts raw quotes, so
 * the quoting desynchronises). These tests pin that no shell is involved at all.
 */
import { describe, expect, it } from "vitest";
import { SpawnTargetError } from "./errors.js";
import { findWindowsExecutableOnPath, resolveSpawnTarget, type SpawnTargetDeps } from "./spawn-target.js";

/** A Windows box with npm's claude shim installed, as our users have. */
function windowsWithNpmShim(overrides: Partial<Record<string, string>> = {}): SpawnTargetDeps {
  const files: Record<string, string> = {
    "C:\\npm\\claude.cmd":
      '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n' +
      '  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js": "#!/usr/bin/env node\n",
    "C:\\nodejs\\node.exe": "",
    ...overrides,
  };
  // Case-INSENSITIVE lookup, because that is what a Windows filesystem does and
  // PATHEXT is upper-case (".CMD"), so a case-sensitive double would fail to find
  // `claude.cmd` and mis-report a product bug that doesn't exist.
  const find = (p: string): string | undefined =>
    Object.keys(files).find((k) => k.toLowerCase() === p.toLowerCase());
  return {
    platform: "win32",
    env: { PATH: "C:\\npm;C:\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    fileExists: (p) => find(p) !== undefined,
    readText: (p) => {
      const key = find(p);
      if (!key) throw new Error("ENOENT");
      return files[key]!;
    },
  };
}

describe("resolveSpawnTarget", () => {
  it("leaves POSIX spawns untouched", () => {
    expect(resolveSpawnTarget("claude", ["--settings", "/tmp/s.json"], { platform: "linux" })).toEqual({
      command: "claude",
      args: ["--settings", "/tmp/s.json"],
    });
    expect(resolveSpawnTarget("codex", [], { platform: "darwin" })).toEqual({ command: "codex", args: [] });
  });

  it("resolves an npm .cmd shim to the interpreter and script it actually runs", () => {
    // The bug: `claude` is claude.cmd, which CreateProcess cannot execute.
    // We spawn node with the shim's own cli.js instead — no shell in the chain.
    const target = resolveSpawnTarget("claude", ["--settings", "C:\\s.json"], windowsWithNpmShim());
    // Case-insensitive on the resolved binary: it comes back with PATHEXT's own
    // casing (".EXE"), which Windows treats as identical.
    expect(target.command.toLowerCase()).toBe("c:\\nodejs\\node.exe");
    expect(target.args).toEqual([
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      "--settings",
      "C:\\s.json",
    ]);
  });

  it("prefers the node.exe npm places beside the shim", () => {
    const deps = windowsWithNpmShim({ "C:\\npm\\node.exe": "" });
    expect(resolveSpawnTarget("claude", [], deps).command.toLowerCase()).toBe("c:\\npm\\node.exe");
  });

  it("NEVER routes through cmd.exe, whatever the arguments contain", () => {
    // Each of these would have been an injection or a mangled value under the
    // cmd.exe wrapper. Now they are argv elements passed through verbatim.
    const hostile = [
      'say "x" & calc.exe & echo "y',
      'developer_instructions="hello"',
      "a|b",
      "c^d",
      "%PATH%",
      '"',
      "",
    ];
    const target = resolveSpawnTarget("claude", hostile, windowsWithNpmShim());
    expect(target.command.toLowerCase()).toBe("c:\\nodejs\\node.exe");
    expect(target.command.toLowerCase()).not.toContain("cmd");
    expect(target.args).not.toContain("/c");
    // Verbatim: no escaping, reordering, or dropping.
    expect(target.args.slice(1)).toEqual(hostile);
  });

  it("passes a real .exe straight through", () => {
    expect(resolveSpawnTarget("cmd.exe", ["/c", "exit", "0"], { platform: "win32" })).toEqual({
      command: "cmd.exe",
      args: ["/c", "exit", "0"],
    });
    expect(
      resolveSpawnTarget("C:\\Program Files\\nodejs\\node.exe", ["-v"], { platform: "win32" }),
    ).toEqual({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["-v"] });
  });

  it("matches executable extensions case-insensitively", () => {
    expect(resolveSpawnTarget("NODE.EXE", [], { platform: "win32" }).command).toBe("NODE.EXE");
    expect(resolveSpawnTarget("SETUP.COM", [], { platform: "win32" }).command).toBe("SETUP.COM");
  });

  it("finds an .exe on PATH by bare name", () => {
    const deps = windowsWithNpmShim();
    const target = resolveSpawnTarget("node", ["-v"], deps);
    expect(target.command.toLowerCase()).toBe("c:\\nodejs\\node.exe");
    expect(target.args).toEqual(["-v"]);
  });

  it("resolves the REAL Claude Code shim, whose target is a native .exe", () => {
    // Verbatim from a user's machine (npm-global install of @anthropic-ai/claude-code).
    // Claude Code ships a native launcher, not a JS entry — keying the parser on
    // `.js` missed it completely and we refused to spawn a perfectly good .exe.
    const exe = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const deps = windowsWithNpmShim({
      "C:\\npm\\claude.cmd":
        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\n" +
        'CALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
      [exe]: "",
    });
    // Straight to the executable: no interpreter, no shell, nothing to quote.
    expect(resolveSpawnTarget("claude", ["--settings", "C:\\s.json"], deps)).toEqual({
      command: exe,
      args: ["--settings", "C:\\s.json"],
    });
  });

  it("prefers claude.cmd over the extensionless sh script npm installs beside it", () => {
    // The exact shape that failed on a user's machine: the harness passed the
    // ABSOLUTE, extensionless path `…\npm-global\claude`. npm installs three
    // files — claude.cmd, claude.ps1 and an extensionless `claude` (a POSIX sh
    // script for Git Bash). Trying the literal name first found that sh script,
    // which Windows cannot execute, and we refused to spawn while claude.cmd sat
    // next to it. CreateProcess and `where` both prefer PATHEXT; so must we.
    const deps = windowsWithNpmShim({ "C:\\npm\\claude": "#!/bin/sh\nexec node …\n" });
    const target = resolveSpawnTarget("C:\\npm\\claude", ["--settings", "C:\\s.json"], deps);
    expect(target.command.toLowerCase()).toBe("c:\\nodejs\\node.exe");
    expect(target.args).toEqual([
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      "--settings",
      "C:\\s.json",
    ]);
  });

  it("reads a shim whose script reference omits the %dp0% prefix", () => {
    // Shim text varies by npm version and package manager; the existence check is
    // what keeps the looser match honest.
    const deps = windowsWithNpmShim({
      "C:\\npm\\claude.cmd":
        '@ECHO off\r\n"%_prog%" "node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    });
    expect(resolveSpawnTarget("claude", [], deps).args[0]).toBe(
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    );
  });

  it("refuses a shim it cannot read, rather than falling back to a shell", () => {
    // A pnpm/yarn/hand-written shim we don't understand. Failing loudly is the
    // point: a cmd.exe fallback here would reintroduce the injection path.
    const deps = windowsWithNpmShim({ "C:\\npm\\claude.cmd": "@echo off\r\nsomething-else.exe %*\r\n" });
    expect(() => resolveSpawnTarget("claude", [], deps)).toThrow(/command injection|could not be determined/i);
  });

  it("refuses when the shim's script is missing", () => {
    const deps = windowsWithNpmShim();
    const noScript: SpawnTargetDeps = {
      ...deps,
      fileExists: (p) => p !== "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" && deps.fileExists!(p),
    };
    expect(() => resolveSpawnTarget("claude", [], noScript)).toThrow(/shim/i);
  });

  it("reports a missing command clearly instead of failing inside CreateProcess", () => {
    expect(() => resolveSpawnTarget("nope", [], windowsWithNpmShim())).toThrow(/not found on PATH/i);
  });

  it("throws typed SpawnTargetError so the server can map it to a 4xx", () => {
    // These failures are user-actionable ("install claude", "restart to repair"),
    // but as plain Errors they surfaced as an opaque 500 "internal error".
    for (const run of [
      () => resolveSpawnTarget("nope", [], windowsWithNpmShim()),
      () =>
        resolveSpawnTarget(
          "claude",
          [],
          windowsWithNpmShim({ "C:\\npm\\claude.cmd": "@echo off\r\nsomething-else.exe %*\r\n" }),
        ),
    ]) {
      let thrown: unknown;
      try {
        run();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SpawnTargetError);
      expect((thrown as SpawnTargetError).code).toBe("SPAWN_TARGET");
    }
  });

  it("names the agent's failed self-update when the target is gone but a .old copy remains", () => {
    // Verbatim wreckage from a user's machine: Claude Code's native updater
    // renamed the running claude.exe to claude.exe.old.<ms-epoch> and failed to
    // write the replacement. Every session spawn then failed with the generic
    // "target could not be determined" — this pins the targeted message.
    const bin = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin";
    const deps = windowsWithNpmShim({
      "C:\\npm\\claude.cmd":
        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\n" +
        'CALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
      [`${bin}\\claude.exe.old.1786481526874`]: "",
    });
    deps.listDir = (dir) =>
      dir.toLowerCase() === bin.toLowerCase() ? ["claude.exe.old.1786481526874"] : [];
    let thrown: unknown;
    try {
      resolveSpawnTarget("claude", [], deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SpawnTargetError);
    expect((thrown as Error).message).toMatch(/self-updater/i);
    expect((thrown as Error).message).toMatch(/restart the app to repair/i);
    expect((thrown as Error).message).toContain("claude.exe");
  });

  it("refuses a .cmd node as the shim's interpreter instead of spawning it", () => {
    // A machine whose only `node` is itself a .cmd (the desktop app's
    // Electron-as-Node shim, LAST on PATH by design): accepting that hit hands
    // CreateProcess a batch file — the exact failure this module exists to end.
    const base = windowsWithNpmShim();
    const deps: SpawnTargetDeps = {
      ...base,
      env: { PATH: "C:\\npm;C:\\shims", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (p) => p.toLowerCase() === "c:\\shims\\node.cmd" || base.fileExists!(p),
    };
    expect(() => resolveSpawnTarget("claude", [], deps)).toThrow(SpawnTargetError);
  });

  it("does not mutate the caller's array", () => {
    const args = ["--one"];
    resolveSpawnTarget("claude", args, windowsWithNpmShim());
    expect(args).toEqual(["--one"]);
  });
});

describe("findWindowsExecutableOnPath", () => {
  const exists =
    (...paths: string[]) =>
    (p: string) =>
      paths.some((k) => k.toLowerCase() === p.toLowerCase());

  it("finds a real node.exe by bare name", () => {
    expect(
      findWindowsExecutableOnPath("node", {
        env: { PATH: "C:\\nodejs" },
        fileExists: exists("C:\\nodejs\\node.exe"),
      })?.toLowerCase(),
    ).toBe("c:\\nodejs\\node.exe");
  });

  it("never returns a .cmd, and keeps searching past one for a real .exe", () => {
    // NOT a filter over the general lookup: a node.cmd in an early PATH dir must
    // not mask the node.exe in a later one.
    expect(
      findWindowsExecutableOnPath("node", {
        env: { PATH: "C:\\shims;C:\\nodejs" },
        fileExists: exists("C:\\shims\\node.cmd", "C:\\nodejs\\node.exe"),
      })?.toLowerCase(),
    ).toBe("c:\\nodejs\\node.exe");
    expect(
      findWindowsExecutableOnPath("node", {
        env: { PATH: "C:\\shims" },
        fileExists: exists("C:\\shims\\node.cmd"),
      }),
    ).toBeNull();
  });

  it("strips quoted PATH entries, as cmd and `where` do", () => {
    expect(
      findWindowsExecutableOnPath("node", {
        env: { PATH: '"C:\\Program Files\\nodejs";C:\\other' },
        fileExists: exists("C:\\Program Files\\nodejs\\node.exe"),
      })?.toLowerCase(),
    ).toBe("c:\\program files\\nodejs\\node.exe");
  });
});
