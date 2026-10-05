import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

/**
 * PRE-TRUST A PROJECT ROOT FOR CLAUDE CODE (flow-map-chat-overlay.md §4.7
 * item 5). A hand-off or Open in session session would otherwise start
 * behind Claude Code's "Do you trust the files in this folder?" dialog, and
 * its first message waits there.
 *
 * Verified against Claude Code 2.1.289:
 * - Trust is `projects[<absolute path>].hasTrustDialogAccepted: true` in the
 *   global config, the same record the dialog writes when the user accepts.
 * - The global config is `<config dir>/.config.json` when that legacy file
 *   exists, else `$CLAUDE_CONFIG_DIR/.claude.json` (home directory when the
 *   variable is unset). `<config dir>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`.
 * - A session is trusted when its folder or a parent up to its git root holds
 *   the record, so one entry for the root covers sessions started inside it.
 * - Claude Code re-reads the file under the lock directory `<file>.lock`
 *   before every save and merges `projects` by key, so an entry written
 *   under the same lock survives a running Claude Code.
 *
 * Only this root's record changes; every other key is kept. Nothing is
 * written when the file is missing (Claude Code restores a missing config
 * from its backups, and a stub would hide that), unreadable, or not an
 * object, and never for the home directory, a folder above it or a
 * filesystem root, whose trust would cover every project beneath them.
 */
export async function trustClaudeCodeProject(
  root: string,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<"trusted" | "already-trusted" | "skipped"> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const keys = await trustKeys(root);
  const homeKey = spell(home);
  const covers = (key: string) =>
    key === spell(parse(key).root) ||
    homeKey === key ||
    homeKey.startsWith(key.endsWith("/") ? key : `${key}/`);
  if (keys.some(covers)) return "skipped";
  const file = await claudeCodeConfigPath(env, home);
  const release = await acquireConfigLock(`${file}.lock`);
  if (!release) return "skipped";
  try {
    // A symlinked config (dotfile managers) is written at its target, so the
    // link survives the rename.
    let target: string;
    let text: string;
    try {
      target = await realpath(file);
      text = await readFile(target, "utf8");
    } catch {
      return "skipped";
    }
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      return "skipped";
    }
    if (!isRecord(config)) return "skipped";
    const projects = config.projects ?? {};
    if (!isRecord(projects)) return "skipped";
    const missing = keys.filter((key) => {
      const entry = projects[key];
      return !(isRecord(entry) && entry.hasTrustDialogAccepted === true);
    });
    if (missing.length === 0) return "already-trusted";
    for (const key of missing) {
      const entry = projects[key];
      projects[key] = {
        ...(isRecord(entry) ? entry : {}),
        hasTrustDialogAccepted: true,
      };
    }
    config.projects = projects;
    const { mode } = await stat(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
        mode: mode & 0o777,
        flag: "wx",
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return "trusted";
  } finally {
    await release();
  }
}

/** The global config file Claude Code 2.1.289 reads (`getGlobalClaudeFile`). */
export async function claudeCodeConfigPath(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string> {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const legacy = join(configDir, ".config.json");
  if (await exists(legacy)) return legacy;
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
  return join(env.CLAUDE_CONFIG_DIR || home, `.claude${suffix}.json`);
}

/**
 * Claude Code keys a project by its absolute, NFC-normalised path, with `/`
 * separators on Windows. A session's cwd arrives resolved through symlinks
 * (macOS `/tmp` is `/private/tmp`), so the resolved spelling is written too
 * when it differs: both name this one folder.
 */
async function trustKeys(root: string): Promise<string[]> {
  const keys = [spell(root)];
  const real = await realpath(root).then(spell, () => null);
  if (real && real !== keys[0]) keys.push(real);
  return keys;
}

function spell(path: string): string {
  const key = resolve(path).normalize("NFC");
  return process.platform === "win32" ? key.replace(/\\/g, "/") : key;
}

/** proper-lockfile's defaults, which Claude Code's config lock uses. */
const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 50;

/**
 * The lock Claude Code takes around a config save: the directory
 * `<file>.lock`, created with mkdir and considered abandoned once its mtime
 * is older than ten seconds. Returns null rather than write without it.
 * Release removes the directory only while it is still the one this call
 * made, so a writer that took over a lock this call held too long keeps it.
 */
export async function acquireConfigLock(
  lock: string,
): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await mkdir(lock);
      const made = await stat(lock);
      return async () => {
        const now = await stat(lock).catch(() => null);
        if (now?.ino === made.ino && now.mtimeMs === made.mtimeMs)
          await rmdir(lock).catch(() => {});
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      const held = await stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        // proper-lockfile's own takeover has the same stat-then-remove gap;
        // a directory lock offers no atomic compare-and-remove.
        const again = await stat(lock).catch(() => null);
        if (again?.ino === held.ino && again.mtimeMs === held.mtimeMs)
          await rmdir(lock).catch(() => {});
        continue;
      }
      await new Promise((done) => setTimeout(done, LOCK_RETRY_MS));
    }
  }
  return null;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
