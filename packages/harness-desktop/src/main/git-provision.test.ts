import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MINGIT_VERSION,
  ensureMinGit,
  minGitAsset,
  minGitBashPath,
  minGitCmdDir,
} from "./git-provision.js";

describe("minGitAsset", () => {
  it("pins an official git-for-windows URL and a sha256 for each supported arch", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const asset = minGitAsset(arch)!;
      expect(asset.url).toMatch(
        /^https:\/\/github\.com\/git-for-windows\/git\/releases\/download\//,
      );
      expect(asset.url).toContain(MINGIT_VERSION);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("returns null for an arch with no MinGit build — the caller degrades to no git", () => {
    expect(minGitAsset("ia32")).toBeNull();
    expect(minGitAsset("ppc64")).toBeNull();
  });
});

describe("ensureMinGit", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("short-circuits on an existing install without touching the network", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mingit-"));
    const installRoot = path.join(root, "mingit");
    mkdirSync(minGitCmdDir(installRoot), { recursive: true });
    writeFileSync(path.join(minGitCmdDir(installRoot), "git.exe"), "");

    const fetchFn = (() => {
      throw new Error("network must not be touched for an existing install");
    }) as unknown as typeof fetch;

    const result = await ensureMinGit({ installRoot, fetchFn });
    expect(result).toEqual({ cmdDir: minGitCmdDir(installRoot), bashPath: null });
  });

  it("reports bash.exe when the installed variant carries one", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mingit-"));
    const installRoot = path.join(root, "mingit");
    mkdirSync(minGitCmdDir(installRoot), { recursive: true });
    writeFileSync(path.join(minGitCmdDir(installRoot), "git.exe"), "");
    mkdirSync(path.dirname(minGitBashPath(installRoot)), { recursive: true });
    writeFileSync(minGitBashPath(installRoot), "");

    const result = await ensureMinGit({ installRoot });
    expect(result?.bashPath).toBe(minGitBashPath(installRoot));
  });

  it("resolves null (never throws) for an unsupported arch", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mingit-"));
    const lines: string[] = [];
    const result = await ensureMinGit({
      installRoot: path.join(root, "mingit"),
      arch: "ia32",
      onLine: (line) => lines.push(line),
    });
    expect(result).toBeNull();
    expect(lines.join("\n")).toContain("no MinGit build");
  });

  it("refuses a download whose checksum does not match the pin — no extraction happens", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mingit-"));
    const lines: string[] = [];
    const fetchFn = (async () =>
      new Response(Buffer.from("not the real MinGit zip"), { status: 200 })) as typeof fetch;

    const result = await ensureMinGit({
      installRoot: path.join(root, "mingit"),
      arch: "x64",
      fetchFn,
      onLine: (line) => lines.push(line),
    });
    expect(result).toBeNull();
    expect(lines.join("\n")).toContain("integrity");
  });

  it("resolves null on a failed download (offline first boot degrades gracefully)", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mingit-"));
    const fetchFn = (async () => new Response(null, { status: 503, statusText: "unavailable" })) as typeof fetch;
    const result = await ensureMinGit({
      installRoot: path.join(root, "mingit"),
      arch: "x64",
      fetchFn,
    });
    expect(result).toBeNull();
  });
});
