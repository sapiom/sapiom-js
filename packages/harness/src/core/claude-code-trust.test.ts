import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireConfigLock,
  claudeCodeConfigPath,
  trustClaudeCodeProject,
} from "./claude-code-trust.js";

let dir: string;
let home: string;
let project: string;
let configFile: string;
const env = {} as NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-trust-")),
  );
  home = path.join(dir, "home");
  project = path.join(dir, "work", "project");
  configFile = path.join(home, ".claude.json");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const writeConfig = (config: unknown, file = configFile) =>
  fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
const readConfig = async (file = configFile) =>
  JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;

describe("trustClaudeCodeProject (SAP-3879)", () => {
  it("writes the trust entry for exactly that root and keeps every other setting", async () => {
    const other = { allowedTools: ["Bash"], hasTrustDialogAccepted: false };
    await writeConfig({
      numStartups: 42,
      oauthAccount: { emailAddress: "someone@example.com" },
      theme: "dark",
      projects: {
        "/elsewhere": other,
        [project]: { allowedTools: ["Read"], lastCost: 1.5 },
      },
    });

    expect(await trustClaudeCodeProject(project, { env, home })).toBe(
      "trusted",
    );

    expect(await readConfig()).toEqual({
      numStartups: 42,
      oauthAccount: { emailAddress: "someone@example.com" },
      theme: "dark",
      projects: {
        "/elsewhere": other,
        [project]: {
          allowedTools: ["Read"],
          lastCost: 1.5,
          hasTrustDialogAccepted: true,
        },
      },
    });
    expect((await fs.stat(configFile)).mode & 0o777).toBe(0o600);
    // Atomic: no temporary file or lock left beside the config.
    expect(await fs.readdir(home)).toEqual([".claude.json"]);
  });

  it("adds a projects map when the config has none", async () => {
    await writeConfig({ numStartups: 1 });
    await trustClaudeCodeProject(project, { env, home });
    expect(await readConfig()).toEqual({
      numStartups: 1,
      projects: { [project]: { hasTrustDialogAccepted: true } },
    });
  });

  it("does not rewrite a root that is already trusted", async () => {
    await writeConfig({
      projects: { [project]: { hasTrustDialogAccepted: true } },
    });
    const before = await fs.readFile(configFile, "utf8");
    expect(await trustClaudeCodeProject(project, { env, home })).toBe(
      "already-trusted",
    );
    expect(await fs.readFile(configFile, "utf8")).toBe(before);
  });

  it("writes nothing when the config is missing, unreadable or not an object", async () => {
    expect(await trustClaudeCodeProject(project, { env, home })).toBe(
      "skipped",
    );
    expect(await fs.readdir(home)).toEqual([]);

    for (const text of ["{ not json", "[]", '{"projects": []}']) {
      await fs.writeFile(configFile, text);
      expect(await trustClaudeCodeProject(project, { env, home })).toBe(
        "skipped",
      );
      expect(await fs.readFile(configFile, "utf8")).toBe(text);
    }
  });

  it("never trusts the home directory, a folder above it, or a filesystem root", async () => {
    await writeConfig({ projects: {} });
    const before = await fs.readFile(configFile, "utf8");
    for (const broad of [
      home,
      dir,
      path.dirname(dir),
      path.parse(project).root,
    ])
      expect(await trustClaudeCodeProject(broad, { env, home })).toBe(
        "skipped",
      );
    expect(await fs.readFile(configFile, "utf8")).toBe(before);
  });

  it("also trusts the resolved spelling when the root is reached through a symlink", async () => {
    const link = path.join(dir, "linked-project");
    await fs.symlink(project, link);
    await writeConfig({ projects: {} });
    await trustClaudeCodeProject(link, { env, home });
    expect((await readConfig()).projects).toEqual({
      [link]: { hasTrustDialogAccepted: true },
      [project]: { hasTrustDialogAccepted: true },
    });
  });

  it("writes through a symlinked config and keeps the link", async () => {
    const dotfiles = path.join(dir, "dotfiles");
    await fs.mkdir(dotfiles);
    const real = path.join(dotfiles, "claude.json");
    await writeConfig({ theme: "light" }, real);
    await fs.symlink(real, configFile);
    await trustClaudeCodeProject(project, { env, home });
    expect((await fs.lstat(configFile)).isSymbolicLink()).toBe(true);
    expect(await readConfig(real)).toEqual({
      theme: "light",
      projects: { [project]: { hasTrustDialogAccepted: true } },
    });
  });

  it("waits for Claude Code's config lock and takes over a stale one", async () => {
    await writeConfig({ projects: {} });
    const lock = `${configFile}.lock`;
    await fs.mkdir(lock);
    const pending = trustClaudeCodeProject(project, { env, home });
    await new Promise((done) => setTimeout(done, 150));
    // Still held: nothing written yet.
    expect((await readConfig()).projects).toEqual({});
    await fs.rmdir(lock);
    expect(await pending).toBe("trusted");

    const other = path.join(dir, "work", "other");
    await fs.mkdir(other);
    await fs.mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    expect(await trustClaudeCodeProject(other, { env, home })).toBe("trusted");
    await expect(fs.stat(lock)).rejects.toThrow();
  });

  it("gives up without writing when the lock stays held", async () => {
    await writeConfig({ projects: {} });
    const lock = `${configFile}.lock`;
    await fs.mkdir(lock);
    expect(await trustClaudeCodeProject(project, { env, home })).toBe(
      "skipped",
    );
    expect((await readConfig()).projects).toEqual({});
    await expect(fs.stat(lock)).resolves.toBeDefined();
  });
});

describe("acquireConfigLock", () => {
  it("leaves a lock another writer took over in place", async () => {
    const lock = path.join(home, ".claude.json.lock");
    const release = await acquireConfigLock(lock);
    expect(release).not.toBeNull();
    // Held past the stale interval: another writer removed it and made its own.
    await fs.rmdir(lock);
    await fs.mkdir(lock);
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(lock, later, later);
    await release!();
    await expect(fs.stat(lock)).resolves.toBeDefined();

    await fs.rmdir(lock);
    const own = await acquireConfigLock(lock);
    await own!();
    await expect(fs.stat(lock)).rejects.toThrow();
  });
});

describe("claudeCodeConfigPath", () => {
  it("follows CLAUDE_CONFIG_DIR and prefers the legacy .config.json", async () => {
    expect(await claudeCodeConfigPath({}, home)).toBe(configFile);
    const configDir = path.join(dir, "config-dir");
    await fs.mkdir(configDir);
    expect(
      await claudeCodeConfigPath({ CLAUDE_CONFIG_DIR: configDir }, home),
    ).toBe(path.join(configDir, ".claude.json"));
    await fs.writeFile(path.join(configDir, ".config.json"), "{}");
    expect(
      await claudeCodeConfigPath({ CLAUDE_CONFIG_DIR: configDir }, home),
    ).toBe(path.join(configDir, ".config.json"));
    await fs.mkdir(path.join(home, ".claude"));
    await fs.writeFile(path.join(home, ".claude", ".config.json"), "{}");
    expect(await claudeCodeConfigPath({}, home)).toBe(
      path.join(home, ".claude", ".config.json"),
    );
  });
});
