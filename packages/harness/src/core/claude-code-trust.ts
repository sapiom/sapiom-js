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
import { dirname, join, parse, resolve } from "node:path";

/** Written only after the user confirms in Studio: the record lets the folder's Claude Code
 *  hooks run without a prompt (SAP-4381; flow-map-chat-overlay.md §4.7 item 5). */
export async function trustClaudeCodeProject(
  root: string,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<"trusted" | "already-trusted" | "skipped"> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const keys = await trustKeys(root);
  if (keys.some(coversHome(home))) return "skipped";
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

/** Lock-free so asking whether to prompt never waits on a writer; "untrustable" mirrors the
 *  writer's root and config refusals, not its lock timeout. */
export async function claudeCodeTrustState(
  root: string,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<"trusted" | "untrusted" | "untrustable"> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const keys = await trustKeys(root);
  if (keys.some(coversHome(home))) return "untrustable";
  let config: unknown;
  try {
    const file = await realpath(await claudeCodeConfigPath(env, home));
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return "untrustable";
  }
  if (!isRecord(config)) return "untrustable";
  const projects = config.projects ?? {};
  if (!isRecord(projects)) return "untrustable";
  const accepted = (key: string) => {
    const entry = projects[key];
    return isRecord(entry) && entry.hasTrustDialogAccepted === true;
  };
  for (const key of keys) {
    if (!(await trustScope(key)).some(accepted)) return "untrusted";
  }
  return "trusted";
}

/** The keys whose record trusts `key` for Claude Code: itself, then each parent up to its git root,
 *  so a project already trusted through its repository is not asked about again. */
async function trustScope(key: string): Promise<string[]> {
  const scope = [key];
  for (let dir = key; ; ) {
    if (await exists(join(dir, ".git"))) return scope;
    const parent = dirname(dir);
    if (parent === dir) return [key];
    dir = parent;
    scope.push(spell(parent));
  }
}

/** A key whose trust would cover every project under home: a filesystem root, home or above. */
function coversHome(home: string): (key: string) => boolean {
  const homeKey = spell(home);
  return (key) =>
    key === spell(parse(key).root) ||
    homeKey === key ||
    homeKey.startsWith(key.endsWith("/") ? key : `${key}/`);
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
