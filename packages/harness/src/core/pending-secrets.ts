/**
 * pending-secrets — credential values authored in Studio BEFORE the agent they
 * belong to exists in the cloud.
 *
 * WHY this exists: Sapiom stores secrets per cloud definition
 * (`POST /v1/workflows/definitions/:id/secrets`), so until a project is linked
 * there is no id to store anything against. That made "set a credential" a
 * thing you could only do after deploying — the deploy you needed the
 * credential for. This store closes that gap: values are held locally, injected
 * into local runs, and pushed to the vault the moment a definition id exists.
 *
 * WHERE, and why not a `.env`: the obvious move is to write `.env` into the
 * agent's project directory. Two things kill it. Nothing would read it —
 * there is no `dotenv` anywhere in `@sapiom/agent-core`, `@sapiom/agent` or the
 * CLI — and it would put plaintext credentials inside a git-tracked tree, one
 * `git add -A` away from being published. So values live under the harness
 * state root, which is outside every project, and reach a local run through the
 * run-local child's environment instead (server/actions.ts).
 *
 * SECURITY POSTURE. This file holds plaintext, so it follows the same rules as
 * `cli/machine-id.ts`: directory 0700, file 0600 on create, and permissions
 * re-asserted on every write so a file created by a looser earlier version does
 * not stay world-readable. Values are never serialized to the browser — the
 * routes expose {@link PendingSecretsStore.names} only, and `values`/`entries`
 * exist for the two server-side consumers (run-local injection, vault flush).
 *
 * DURABILITY. Writes are atomic (temp file in the same directory, then rename)
 * so a crash mid-write leaves the temp file rather than a truncated store —
 * the pattern `core/workflow-registry.ts` uses for the same reason. Reads are
 * served from an in-memory snapshot loaded once at boot, because the run-local
 * route spawns its child synchronously and must not become async to ask a disk
 * for four strings.
 */

import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { HARNESS_PATHS } from "../shared/types.js";
import { expandHome } from "./paths.js";

/** `{ [absolute project path]: { [SECRET_NAME]: value } }` — the on-disk shape. */
type PendingSecretsFile = Record<string, Record<string, string>>;

export interface PendingSecretsStore {
  /**
   * The names held for a project, sorted. This is the ONLY accessor whose
   * result may reach the browser: a name is listable, a value never is.
   */
  names(projectPath: string): string[];
  /**
   * Name→value for injection into a local run's environment. Server-side only.
   * Returns a fresh object so a caller cannot mutate the store through it.
   */
  values(projectPath: string): Record<string, string>;
  /** Name/value pairs for the vault flush. Server-side only. */
  entries(projectPath: string): { key: string; value: string }[];
  /** Writes a value, replacing any existing one under the same name. */
  set(projectPath: string, key: string, value: string): Promise<void>;
  /** Forgets one name. Used by the tab's delete, and by "remove local copy". */
  remove(projectPath: string, key: string): Promise<void>;
  /**
   * Forgets several names at once — the explicit "remove local copies after
   * upload" action. Deliberately NOT called by the deploy flush: see the note
   * on {@link createPendingSecretsStore}.
   */
  removeMany(projectPath: string, keys: string[]): Promise<void>;
}

/**
 * Loads the store from disk and returns it. Never throws: an unreadable or
 * corrupt file yields an empty store rather than taking server boot down over
 * credentials the user can re-enter. A corrupt file is NOT deleted — it is left
 * in place so the values can be recovered by hand.
 *
 * NOTE ON THE DEPLOY FLUSH: a successful upload does NOT clear the local copy.
 * The vault has no read path by design, so once the local value is gone the
 * harness can never re-populate it — and local runs would silently stop
 * receiving credentials at exactly the moment the agent starts working in the
 * cloud. The tab shows an uploaded name as synced and offers removing the local
 * copy as its own explicit action.
 *
 * @param filePath Where the store lives. Defaults to the real state root; the
 *   server passes a path derived from `--state-root` so a test or a scripted
 *   check can never touch the developer's real credentials.
 */
export async function createPendingSecretsStore(
  filePath: string = expandHome(HARNESS_PATHS.pendingSecrets),
): Promise<PendingSecretsStore> {
  let snapshot: PendingSecretsFile = await read(filePath);
  /** Serializes writes so two concurrent sets cannot drop one another. */
  let writeQueue: Promise<void> = Promise.resolve();

  const forProject = (projectPath: string): Record<string, string> =>
    snapshot[projectPath] ?? {};

  const mutate = (
    projectPath: string,
    apply: (secrets: Record<string, string>) => Record<string, string>,
  ): Promise<void> => {
    const next: PendingSecretsFile = { ...snapshot };
    const secrets = apply({ ...forProject(projectPath) });
    // An empty project key is noise in the file and reads as "this project has
    // a secrets record" when it does not. Drop it instead.
    if (Object.keys(secrets).length === 0) delete next[projectPath];
    else next[projectPath] = secrets;
    snapshot = next;
    writeQueue = writeQueue.then(() => write(filePath, next)).catch(() => {
      // A failed write leaves the in-memory snapshot ahead of disk. That is the
      // right way round: the value still reaches this session's runs, and the
      // next successful write reconciles. Losing it in memory too would be
      // strictly worse.
    });
    return writeQueue;
  };

  return {
    names(projectPath) {
      return Object.keys(forProject(projectPath)).sort();
    },
    values(projectPath) {
      return { ...forProject(projectPath) };
    },
    entries(projectPath) {
      return Object.entries(forProject(projectPath))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value }));
    },
    set(projectPath, key, value) {
      return mutate(projectPath, (secrets) => ({ ...secrets, [key]: value }));
    },
    remove(projectPath, key) {
      return mutate(projectPath, (secrets) => {
        delete secrets[key];
        return secrets;
      });
    },
    removeMany(projectPath, keys) {
      return mutate(projectPath, (secrets) => {
        for (const key of keys) delete secrets[key];
        return secrets;
      });
    },
  };
}

/** Reads and narrows the file. Anything unparseable or wrong-shaped reads as
 *  empty — a malformed store must not crash boot. */
async function read(filePath: string): Promise<PendingSecretsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return {};
  }
  try {
    return narrow(JSON.parse(raw));
  } catch {
    console.error(
      `[harness] ${filePath} is not valid JSON; pending secrets start empty. ` +
        "The file is left in place — recover any values from it by hand.",
    );
    return {};
  }
}

/** Field-by-field narrowing: one bad project entry is dropped, not the file. */
function narrow(parsed: unknown): PendingSecretsFile {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: PendingSecretsFile = {};
  for (const [projectPath, secrets] of Object.entries(parsed)) {
    if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
      continue;
    }
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (typeof value === "string") kept[key] = value;
    }
    if (Object.keys(kept).length > 0) out[projectPath] = kept;
  }
  return out;
}

/**
 * Atomic, private write. The temp file is created in the SAME directory so the
 * rename is same-filesystem (and therefore atomic on POSIX), and it is created
 * 0600 as well — a world-readable temp file holding every credential would
 * defeat the point even for the moment it exists.
 */
async function write(filePath: string, file: PendingSecretsFile): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = join(
    dirname(filePath),
    `.${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tmpPath, JSON.stringify(file, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(tmpPath, filePath);
    // `mode` on writeFile applies only when CREATING; after a rename over a
    // pre-existing file the target keeps whatever permissions it had. Re-assert
    // so a store written by a looser earlier version is hardened in place —
    // the same reason machine-id.ts hardens on every read.
    await fs.chmod(filePath, 0o600).catch(() => {
      // Best effort; a chmod failure must not lose the write that succeeded.
    });
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
