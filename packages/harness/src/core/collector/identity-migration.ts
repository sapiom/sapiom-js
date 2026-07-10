/**
 * One-way identity migration: seed `~/.sapiom/analytics.json` from the
 * harness's legacy `~/.sapiom/harness/machine-id` when analytics.json does
 * not yet exist. Idempotent: a subsequent call after analytics.json exists is
 * always a no-op.
 *
 * Purpose: existing installs of harness 0.1.x had a stable anonymous id in
 * the harness-specific machine-id file. Seeding the canonical analytics.json
 * from that value preserves the longitudinal join key so prior sessions stay
 * attributable to the same install after the upgrade.
 *
 * Contract:
 * - Reads machine-id only if analytics.json is absent (avoids file-system
 *   I/O on the hot path for already-migrated installs).
 * - Never throws; degrades silently on any I/O failure (unwritable HOME, etc.)
 * - Call once at harness server boot, before the analytics emitter is created
 *   (so the emitter's IdentityStore finds the seeded file on first track()).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { seedAnalyticsIdentity } from "@sapiom/analytics-core";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveHomeDir(): string {
  const fromEnv = process.env.HOME || process.env.USERPROFILE;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return os.homedir();
}

/**
 * @param legacyMachineIdPath Absolute path to `~/.sapiom/harness/machine-id`.
 * @param analyticsJsonPath Absolute path to `~/.sapiom/analytics.json`.
 *   Defaults to the canonical location.
 */
export async function migrateHarnessIdentity(
  legacyMachineIdPath: string,
  analyticsJsonPath?: string,
): Promise<void> {
  try {
    const targetPath =
      analyticsJsonPath ??
      path.join(resolveHomeDir(), ".sapiom", "analytics.json");

    // analytics.json already exists — nothing to migrate.
    try {
      await fs.access(targetPath);
      return;
    } catch {
      // File doesn't exist — proceed to migration attempt.
    }

    // Read the legacy machine-id.
    let machineId: string;
    try {
      machineId = (await fs.readFile(legacyMachineIdPath, "utf8")).trim();
    } catch {
      // Legacy file doesn't exist (fresh install) — let analytics-core
      // generate a new id naturally on first track().
      return;
    }

    // Validate shape: a non-UUID machine-id shouldn't be propagated.
    if (!UUID_SHAPE.test(machineId)) return;

    // Seed analytics.json. seedAnalyticsIdentity handles atomic write +
    // 0600 permissions + degrade-on-error.
    seedAnalyticsIdentity(machineId);
  } catch {
    // Migration failures must never crash the server.
  }
}
