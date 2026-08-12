/**
 * Provision `git` on Windows machines that have none.
 *
 * Why: the app's own doors shell out to a real git — template cloning
 * (agent-core's `cloneRepo`) and deploy (`pushSynthesizedTree`) — and Windows
 * ships no git. The target user is the one-click desktop user who has no
 * developer tooling at all (the same reason node/npm/npx shims and the Claude
 * Code auto-install exist), so "go install Git for Windows" is friction this
 * host is supposed to remove. A bonus when present: Claude Code prefers Git
 * Bash for its shell on Windows, so a provisioned bash.exe upgrades the
 * agent's own Bash tool via CLAUDE_CODE_GIT_BASH_PATH.
 *
 * How: download the official MinGit zip from git-for-windows' GitHub releases
 * at first boot, verify it against a PINNED sha256, and extract it under
 * userData. Downloading from upstream at runtime (GitHub Desktop's dugite
 * model) rather than bundling keeps ~36MB out of every installer and keeps us
 * out of the GPL redistribution business; the checksum pin means a tampered
 * or moved asset yields "no git" (with the existing GIT_NOT_INSTALLED remedy
 * downstream), never an unverified binary.
 *
 * Non-fatal by contract: the app must boot identically with or without this
 * succeeding — offline first runs simply keep today's behavior.
 *
 * This module is pure/electron-free (the caller supplies the install root);
 * the pinned-asset and layout helpers are exported for the vitest tier.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The pinned MinGit release. Bump deliberately (new sha256s from the release
 * notes at github.com/git-for-windows/git/releases) — the version is not
 * security-critical to chase, and an unpinned "latest" would defeat the
 * checksum.
 */
export const MINGIT_VERSION = "2.55.0.4";
const RELEASE_BASE =
  "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4";

export interface MinGitAsset {
  url: string;
  sha256: string;
}

/** sha256 values from the v2.55.0.windows.4 release notes. */
const MINGIT_ASSETS: Partial<Record<string, MinGitAsset>> = {
  x64: {
    url: `${RELEASE_BASE}/MinGit-${MINGIT_VERSION}-64-bit.zip`,
    sha256: "4e03f94c2ffbf70be337e005cee02661c732dbfc81031a078bda9299b9a7d644",
  },
  arm64: {
    url: `${RELEASE_BASE}/MinGit-${MINGIT_VERSION}-arm64.zip`,
    sha256: "033eb6b927d804558ae479a6ae6c6ed86da42cabc0d424844a3e108c780a58cc",
  },
};

/** The pinned asset for a `process.arch` value, or null when unsupported. */
export function minGitAsset(arch: string): MinGitAsset | null {
  return MINGIT_ASSETS[arch] ?? null;
}

/** Where git.exe's directory lands inside an extracted MinGit root. */
export function minGitCmdDir(installRoot: string): string {
  return path.join(installRoot, "cmd");
}

/**
 * MinGit ships a minimal sh/bash for git's own script commands, but its
 * presence varies by variant — detected at runtime, never assumed. When
 * present it is worth advertising to Claude Code (CLAUDE_CODE_GIT_BASH_PATH):
 * its Bash tool and hook shell prefer Git Bash over the PowerShell fallback.
 */
export function minGitBashPath(installRoot: string): string {
  return path.join(installRoot, "usr", "bin", "bash.exe");
}

export interface ProvisionedGit {
  /** Directory containing git.exe — append to PATH (after any system entries). */
  cmdDir: string;
  /** bash.exe inside the install, when this MinGit variant carries one. */
  bashPath: string | null;
}

export interface EnsureMinGitOptions {
  /** Directory the MinGit tree lives under (e.g. `<userData>/mingit`). */
  installRoot: string;
  /** Overridable for tests. */
  arch?: string;
  fetchFn?: typeof fetch;
  /** Progress/diagnostic line sink (setup window + boot log). */
  onLine?: (line: string) => void;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function describeInstall(installRoot: string): Promise<ProvisionedGit> {
  return {
    cmdDir: minGitCmdDir(installRoot),
    bashPath: (await pathExists(minGitBashPath(installRoot))) ? minGitBashPath(installRoot) : null,
  };
}

/**
 * Ensure a working MinGit under `installRoot`, downloading and extracting it
 * if absent. Resolves null on ANY failure (unsupported arch, offline,
 * checksum mismatch, extraction failure, broken git.exe) — never throws, per
 * the non-fatal contract above. An already-provisioned install short-circuits
 * on the existence of `cmd/git.exe` (no network, no version probe: upgrades
 * happen by bumping the pin, which changes nothing for existing installs
 * until a repair/cleanup path needs it).
 */
export async function ensureMinGit(options: EnsureMinGitOptions): Promise<ProvisionedGit | null> {
  const { installRoot } = options;
  const onLine = options.onLine ?? (() => {});
  const gitExe = path.join(minGitCmdDir(installRoot), "git.exe");

  try {
    if (await pathExists(gitExe)) return await describeInstall(installRoot);

    const asset = minGitAsset(options.arch ?? process.arch);
    if (!asset) {
      onLine(`Git setup skipped: no MinGit build for ${options.arch ?? process.arch}.`);
      return null;
    }

    onLine(`Downloading Git ${MINGIT_VERSION}…`);
    const fetchFn = options.fetchFn ?? fetch;
    const res = await fetchFn(asset.url);
    if (!res.ok) {
      onLine(`Git download failed: ${res.status} ${res.statusText}.`);
      return null;
    }
    const zipBytes = Buffer.from(await res.arrayBuffer());

    const digest = createHash("sha256").update(zipBytes).digest("hex");
    if (digest !== asset.sha256) {
      // Never extract an unverified archive — degrade to "no git" instead.
      onLine("Git download failed integrity verification — skipping.");
      return null;
    }

    // Stage next to the final root so a crash mid-extract can't leave a
    // half-populated install that the git.exe existence check would trust.
    const parent = path.dirname(installRoot);
    await fs.mkdir(parent, { recursive: true });
    const staging = await fs.mkdtemp(path.join(parent, ".mingit-"));
    const zipPath = path.join(staging, "mingit.zip");
    try {
      await fs.writeFile(zipPath, zipBytes);
      onLine("Extracting Git…");
      // Expand-Archive ships with every supported Windows — no unzip
      // dependency. -EncodedCommand so no shell ever tokenizes the paths
      // (userData can carry spaces and apostrophes); windowsHide so this can
      // never flash a console at the user (see mcp/src/auth.ts for the same
      // rule, learned the hard way).
      const extractTo = path.join(staging, "tree");
      const psCommand = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractTo.replace(/'/g, "''")}' -Force`;
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-EncodedCommand",
          Buffer.from(psCommand, "utf16le").toString("base64"),
        ],
        { windowsHide: true, timeout: 120_000 },
      );

      // Prove the binary actually runs before promoting the tree — an
      // extraction that "succeeded" but can't execute must not persist.
      const stagedGit = path.join(minGitCmdDir(extractTo), "git.exe");
      const { stdout } = await execFileAsync(stagedGit, ["--version"], {
        windowsHide: true,
        timeout: 15_000,
      });
      await fs.rm(installRoot, { recursive: true, force: true });
      await fs.rename(extractTo, installRoot);
      onLine(`Git ready (${stdout.trim()}).`);
      return await describeInstall(installRoot);
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    onLine(`Git setup failed: ${err instanceof Error ? err.message : String(err)}.`);
    return null;
  }
}
