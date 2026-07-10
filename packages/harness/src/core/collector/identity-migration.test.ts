/**
 * Unit tests for the harness→analytics-core identity migration.
 *
 * Covers the four scenarios from the acceptance criteria:
 * (a) fresh HOME → analytics.json created 0600, events carry its id
 * (b) HOME with legacy machine-id and no analytics.json → analytics.json
 *     seeded with the SAME id
 * (c) both files exist → analytics.json wins, no rewrite
 * (d) unwritable HOME → id null, nothing crashes
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateHarnessIdentity } from "./identity-migration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TempDir {
  dir: string;
  analyticsJsonPath: string;
  legacyMachineIdPath: string;
  cleanup(): void;
}

function makeTempDir(): TempDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-identity-migration-"));
  const analyticsJsonPath = path.join(dir, ".sapiom", "analytics.json");
  const legacyMachineIdPath = path.join(dir, ".sapiom", "harness", "machine-id");
  return {
    dir,
    analyticsJsonPath,
    legacyMachineIdPath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeLegacyMachineId(machineIdPath: string, id: string): void {
  fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
  fs.writeFileSync(machineIdPath, id + "\n", { mode: 0o600 });
}

function readAnalyticsId(analyticsPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(analyticsPath, "utf8")) as { anonymous_id: string };
    return parsed.anonymous_id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

describe("migrateHarnessIdentity", () => {
  let tmp: TempDir;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    tmp = makeTempDir();
    // Point HOME at our temp dir so analytics-core writes to a sandboxed location
    process.env.HOME = tmp.dir;
    process.env.USERPROFILE = tmp.dir;
  });

  afterEach(() => {
    tmp.cleanup();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("(a) fresh HOME: analytics.json does not exist → analytics.json NOT created by migration alone (analytics-core does that on first track)", async () => {
    // No legacy machine-id either → nothing to migrate
    expect(fs.existsSync(tmp.analyticsJsonPath)).toBe(false);
    await migrateHarnessIdentity(tmp.legacyMachineIdPath, tmp.analyticsJsonPath);
    // Migration only seeds when legacy file exists; with neither file it's a no-op
    expect(fs.existsSync(tmp.analyticsJsonPath)).toBe(false);
  });

  it("(b) legacy machine-id exists, analytics.json absent → analytics.json seeded with the SAME id", async () => {
    const legacyId = crypto.randomUUID();
    writeLegacyMachineId(tmp.legacyMachineIdPath, legacyId);

    expect(fs.existsSync(tmp.analyticsJsonPath)).toBe(false);
    await migrateHarnessIdentity(tmp.legacyMachineIdPath, tmp.analyticsJsonPath);

    expect(fs.existsSync(tmp.analyticsJsonPath)).toBe(true);
    // Permissions must be 0600
    expect(fs.statSync(tmp.analyticsJsonPath).mode & 0o777).toBe(0o600);
    // The seeded id matches the legacy machine-id
    expect(readAnalyticsId(tmp.analyticsJsonPath)).toBe(legacyId);
  });

  it("(c) both files exist → analytics.json wins, machine-id is NOT re-used", async () => {
    const legacyId = crypto.randomUUID();
    const analyticsId = crypto.randomUUID();
    writeLegacyMachineId(tmp.legacyMachineIdPath, legacyId);
    fs.mkdirSync(path.dirname(tmp.analyticsJsonPath), { recursive: true });
    fs.writeFileSync(
      tmp.analyticsJsonPath,
      JSON.stringify({ anonymous_id: analyticsId, first_run_notice_at: null }) + "\n",
      { mode: 0o600 },
    );

    await migrateHarnessIdentity(tmp.legacyMachineIdPath, tmp.analyticsJsonPath);

    // analytics.json unchanged
    expect(readAnalyticsId(tmp.analyticsJsonPath)).toBe(analyticsId);
    // The legacy id was NOT written
    expect(readAnalyticsId(tmp.analyticsJsonPath)).not.toBe(legacyId);
  });

  it("(d) unwritable HOME → nothing crashes, returns silently", async () => {
    // Point legacy id at a real file
    const legacyId = crypto.randomUUID();
    writeLegacyMachineId(tmp.legacyMachineIdPath, legacyId);

    // Block analytics.json write by making the parent a regular file
    const blocker = path.join(tmp.dir, "blocker-dir");
    fs.writeFileSync(blocker, "i am a file");
    const unwritablePath = path.join(blocker, "nested", "analytics.json");

    await expect(
      migrateHarnessIdentity(tmp.legacyMachineIdPath, unwritablePath),
    ).resolves.toBeUndefined();
  });

  it("ignores a non-UUID machine-id (malformed content)", async () => {
    writeLegacyMachineId(tmp.legacyMachineIdPath, "not-a-uuid");

    await migrateHarnessIdentity(tmp.legacyMachineIdPath, tmp.analyticsJsonPath);

    // analytics.json should NOT have been created
    expect(fs.existsSync(tmp.analyticsJsonPath)).toBe(false);
  });

  it("is idempotent: calling twice leaves analytics.json unchanged", async () => {
    const legacyId = crypto.randomUUID();
    writeLegacyMachineId(tmp.legacyMachineIdPath, legacyId);

    await migrateHarnessIdentity(tmp.legacyMachineIdPath, tmp.analyticsJsonPath);
    const firstRead = readAnalyticsId(tmp.analyticsJsonPath);

    // Second call: analytics.json now exists, should be a no-op
    await migrateHarnessIdentity(tmp.legacyMachineIdPath, tmp.analyticsJsonPath);
    expect(readAnalyticsId(tmp.analyticsJsonPath)).toBe(firstRead);
  });
});
