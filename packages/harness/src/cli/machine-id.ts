import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { HARNESS_PATHS } from "../shared/types.js";
import { expandHome } from "./paths.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stable anonymous install id, used to tag every analytics event
 * (`AnalyticsEvent.machineId`) regardless of which Sapiom user is signed in.
 * Created once on first run and reused forever after.
 *
 * Hardened per `@sapiom/analytics-core`'s `identity.ts` pattern: private
 * file permissions (mode 0600, on both create and a pre-existing file),
 * silent regeneration when the stored content is missing/corrupt, and
 * graceful degradation — an unreadable/unwritable HOME must never crash
 * server boot over an analytics nicety. Kept as our own plain-text
 * `~/.sapiom/harness/machine-id` file for now; converging onto her
 * `~/.sapiom/analytics.json` identity is a separate, later conversation.
 *
 * @param filePath Where the id file lives. Defaults to the real
 *   `HARNESS_PATHS.machineId`; tests and scripted checks pass a path under
 *   their scratch state root so a boot never writes to the real home dir.
 */
export async function getOrCreateMachineId(
  filePath: string = expandHome(HARNESS_PATHS.machineId),
): Promise<string> {
  try {
    const existing = await readMachineId(filePath);
    if (existing) {
      // Re-assert privacy even when we're not writing: a file created by a
      // pre-hardening version of the harness (default `fs.writeFile` perms,
      // typically 0644) would otherwise stay loosely-permissioned forever,
      // since its content never needs to change again once it exists.
      await hardenPermissions(filePath);
      return existing;
    }

    const id = crypto.randomUUID();
    await writeMachineId(filePath, id);
    return id;
  } catch {
    // Persistence is impossible (unwritable/unreadable HOME, permissions,
    // whatever) — hand back a fresh id for this process rather than taking
    // the server down over it. It won't be stable across runs, but every
    // event within this run is at least internally consistent.
    return crypto.randomUUID();
  }
}

/** Reads and validates the persisted id. Missing, empty, or malformed
 *  content returns `undefined` so the caller regenerates — same recovery
 *  posture as `identity.ts`'s corrupt/wrong-shape handling. */
async function readMachineId(filePath: string): Promise<string | undefined> {
  try {
    const raw = (await fs.readFile(filePath, "utf-8")).trim();
    return UUID_SHAPE.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function writeMachineId(filePath: string, id: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // `mode` on writeFile only applies when creating the file — the follow-up
  // hardenPermissions() covers the (unlikely but possible) case of writing
  // over a pre-existing file at this path with looser permissions.
  await fs.writeFile(filePath, id + "\n", { mode: 0o600 });
  await hardenPermissions(filePath);
}

async function hardenPermissions(filePath: string): Promise<void> {
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best effort.
  }
}
