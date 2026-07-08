/**
 * Exercises the spawn-helper repair path with mocked fs: published node-pty
 * prebuilds can ship `spawn-helper` without the executable bit, and the
 * runtime chmods it back best-effort. These tests pin the path assembly and
 * the repair/no-repair decisions without touching the real filesystem.
 */
import * as fs from "node:fs";
import { ensureSpawnHelperExecutable } from "../pty-runtime.js";

jest.mock("node:fs", () => {
  const actual = jest.requireActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    accessSync: jest.fn(actual.accessSync),
    chmodSync: jest.fn(),
  };
});

const mockedFs = fs as jest.Mocked<Pick<typeof fs, "existsSync" | "accessSync" | "chmodSync">> &
  typeof fs;

// The repair is a POSIX-only concern; there is no spawn-helper on Windows.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("ensureSpawnHelperExecutable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("chmods the prebuilt helper to 0o755 when it exists but is not executable", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.accessSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    ensureSpawnHelperExecutable();

    expect(mockedFs.chmodSync).toHaveBeenCalledTimes(1);
    const [helperPath, mode] = mockedFs.chmodSync.mock.calls[0];
    expect(String(helperPath)).toMatch(
      new RegExp(
        `node-pty[\\\\/].*prebuilds[\\\\/]${process.platform}-${process.arch}[\\\\/]spawn-helper$`,
      ),
    );
    expect(mode).toBe(0o755);
  });

  it("does nothing when the helper is already executable", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.accessSync.mockImplementation(() => undefined);

    ensureSpawnHelperExecutable();

    expect(mockedFs.chmodSync).not.toHaveBeenCalled();
  });

  it("does nothing when no prebuilt helper exists (compiled from source)", () => {
    mockedFs.existsSync.mockReturnValue(false);

    ensureSpawnHelperExecutable();

    expect(mockedFs.chmodSync).not.toHaveBeenCalled();
  });

  it("swallows chmod failures — the spawn itself reports the real error", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.accessSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockedFs.chmodSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(() => ensureSpawnHelperExecutable()).not.toThrow();
  });
});
