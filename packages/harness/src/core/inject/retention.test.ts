import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GENERATED_SWEEP_MAX_AGE_MS,
  removeGeneratedSessionDir,
  sweepGeneratedDirs,
} from "./retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("generated-dir retention", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "harness-retention-"));
    // The safety guard requires the root's final segment to be "generated".
    root = join(tmp, "generated");
    await mkdir(root);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Creates root/<name>/settings.json, optionally backdating the dir's mtime. */
  async function seedSessionDir(name: string, ageMs = 0): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), "{}\n");
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      await utimes(dir, then, then);
    }
    return dir;
  }

  describe("removeGeneratedSessionDir", () => {
    it("removes the session's dir and its contents", async () => {
      const dir = await seedSessionDir("session-1");
      await expect(removeGeneratedSessionDir("session-1", { generatedRoot: root })).resolves.toBe(true);
      await expect(exists(dir)).resolves.toBe(false);
      // The root itself is untouched.
      await expect(exists(root)).resolves.toBe(true);
    });

    it("is a no-op for a dir that doesn't exist", async () => {
      await expect(removeGeneratedSessionDir("never-created", { generatedRoot: root })).resolves.toBe(false);
    });

    it("never deletes outside the root for escaping or malformed ids", async () => {
      const victim = join(tmp, "victim");
      await mkdir(victim);
      await writeFile(join(victim, "keep.txt"), "keep");
      for (const id of ["..", ".", "", "../victim", "a/../../victim", "nested/dir", "/", tmp]) {
        await expect(removeGeneratedSessionDir(id, { generatedRoot: root })).resolves.toBe(false);
      }
      await expect(exists(join(victim, "keep.txt"))).resolves.toBe(true);
    });

    it("refuses to operate under a root that doesn't look like a generated dir", async () => {
      // tmp's final segment isn't "generated" — a misconfigured base path
      // must fail loudly instead of recursively deleting under it.
      await expect(removeGeneratedSessionDir("session-1", { generatedRoot: tmp })).rejects.toThrow(
        /suspicious generated root/,
      );
      await expect(removeGeneratedSessionDir("session-1", { generatedRoot: "/" })).rejects.toThrow(
        /suspicious generated root/,
      );
    });

    it("skips a symlinked entry instead of following it", async () => {
      const target = join(tmp, "target");
      await mkdir(target);
      await writeFile(join(target, "keep.txt"), "keep");
      await symlink(target, join(root, "linked-session"));
      await expect(removeGeneratedSessionDir("linked-session", { generatedRoot: root })).resolves.toBe(false);
      await expect(exists(join(target, "keep.txt"))).resolves.toBe(true);
      await expect(exists(join(root, "linked-session"))).resolves.toBe(true);
    });
  });

  describe("sweepGeneratedDirs", () => {
    it("removes stale dirs and keeps fresh ones", async () => {
      const stale = await seedSessionDir("stale-session", 8 * DAY_MS);
      const fresh = await seedSessionDir("fresh-session");
      const removed = await sweepGeneratedDirs({ generatedRoot: root });
      expect(removed).toEqual(["stale-session"]);
      await expect(exists(stale)).resolves.toBe(false);
      await expect(exists(fresh)).resolves.toBe(true);
    });

    it("keeps a live session's dir regardless of age", async () => {
      const live = await seedSessionDir("live-session", 30 * DAY_MS);
      const dead = await seedSessionDir("dead-session", 30 * DAY_MS);
      const removed = await sweepGeneratedDirs({
        generatedRoot: root,
        isLiveSession: (id) => id === "live-session",
      });
      expect(removed).toEqual(["dead-session"]);
      await expect(exists(live)).resolves.toBe(true);
      await expect(exists(dead)).resolves.toBe(false);
    });

    it("respects a custom maxAgeMs", async () => {
      const older = await seedSessionDir("older", 10_000);
      const newer = await seedSessionDir("newer", 1_000);
      const removed = await sweepGeneratedDirs({ generatedRoot: root, maxAgeMs: 5_000 });
      expect(removed).toEqual(["older"]);
      await expect(exists(older)).resolves.toBe(false);
      await expect(exists(newer)).resolves.toBe(true);
    });

    it("defaults to a 7-day threshold", () => {
      expect(GENERATED_SWEEP_MAX_AGE_MS).toBe(7 * DAY_MS);
    });

    it("leaves stray files and symlinked dirs alone (never follows a symlink)", async () => {
      const strayFile = join(root, "stray.txt");
      await writeFile(strayFile, "stray");
      const then = new Date(Date.now() - 30 * DAY_MS);
      await utimes(strayFile, then, then);

      const target = join(tmp, "target");
      await mkdir(target);
      await writeFile(join(target, "keep.txt"), "keep");
      const link = join(root, "linked-session");
      await symlink(target, link);

      const removed = await sweepGeneratedDirs({ generatedRoot: root, maxAgeMs: 0 });
      expect(removed).toEqual([]);
      await expect(exists(strayFile)).resolves.toBe(true);
      await expect(exists(link)).resolves.toBe(true);
      await expect(exists(join(target, "keep.txt"))).resolves.toBe(true);
    });

    it("returns empty when the root doesn't exist yet", async () => {
      await expect(sweepGeneratedDirs({ generatedRoot: join(tmp, "nope", "generated") })).resolves.toEqual([]);
    });

    it("refuses a suspicious root", async () => {
      await expect(sweepGeneratedDirs({ generatedRoot: tmp })).rejects.toThrow(/suspicious generated root/);
    });
  });
});
