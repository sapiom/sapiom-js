import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DurableFileLock } from "./durable-file-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-lock-"));
  roots.push(root);
  const target = path.join(root, "state.json");
  return { root, target, lockPath: `${target}.lock` };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cleanupProof(root: string, digit: string) {
  return {
    path: path.join(root, `cleanup-${digit.repeat(32)}.json`),
    token: digit.repeat(64),
  };
}

function storedProof(root: string, proof: ReturnType<typeof cleanupProof>) {
  return {
    relativePath: path.relative(root, proof.path),
    token: proof.token,
  };
}

describe("DurableFileLock", () => {
  it("serializes live owners and preserves ordinary dead-legacy reclaim", async () => {
    const { target, lockPath } = await fixture();
    const release = await new DurableFileLock(target).acquire();
    let secondAcquired = false;
    const second = new DurableFileLock(target).acquire().then((unlock) => {
      secondAcquired = true;
      return unlock;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);
    await release();
    await (
      await second
    )();
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: "dead", pid: 999_999_999 })}\n`,
    );
    await (
      await new DurableFileLock(target, {
        hooks: { isPidAlive: () => false },
      }).acquire()
    )();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks a dead legacy runtime owner but reclaims versioned prelaunch", async () => {
    const { target, lockPath } = await fixture();
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: "legacy", pid: 999_999_999 })}\n`,
    );
    await expect(
      new DurableFileLock(target, {
        processGuard: "required",
        timeoutMs: 5,
        retryMs: 1,
        hooks: { isPidAlive: () => false },
      }).acquire(),
    ).rejects.toThrow("Storage unavailable");

    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        ownerId: "prelaunch",
        pid: 999_999_999,
        birthId: "old-birth",
        state: "prelaunch",
        version: 2,
      })}\n`,
    );
    const release = await new DurableFileLock(target, {
      processGuard: "required",
      hooks: { isPidAlive: () => false },
    }).acquire();
    await release();
  });

  it("requires an exact cleanup proof for a guarded dead supervisor", async () => {
    const { root, target, lockPath } = await fixture();
    const owner = {
      ownerId: "guarded",
      pid: 999_999_999,
      state: "prelaunch",
      version: 2,
    } as const;
    const proof = cleanupProof(root, "a");
    await fs.writeFile(lockPath, `${JSON.stringify(owner)}\n`);
    await fs.writeFile(
      `${lockPath}.guard-${owner.ownerId}`,
      `${JSON.stringify({
        ownerId: owner.ownerId,
        version: 2,
        pid: 999_999_998,
        cleanupProof: storedProof(root, proof),
      })}\n`,
    );
    const options = {
      processGuard: "required" as const,
      timeoutMs: 5,
      retryMs: 1,
      hooks: { isPidAlive: () => false },
    };
    await expect(
      new DurableFileLock(target, options).acquire(),
    ).rejects.toThrow("Storage unavailable");
    await fs.writeFile(
      proof.path,
      `${JSON.stringify({ status: "complete", token: "wrong" })}\n`,
    );
    await expect(
      new DurableFileLock(target, options).acquire(),
    ).rejects.toThrow("Storage unavailable");
    await fs.writeFile(
      proof.path,
      `${JSON.stringify({ status: "complete", token: proof.token })}\n`,
    );
    const replacement = await new DurableFileLock(target, options).acquire();
    await expect(fs.access(proof.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await replacement();
  });

  it("blocks malformed guards in required mode", async () => {
    const { target, lockPath } = await fixture();
    const owner = {
      ownerId: "malformed",
      pid: 999_999_999,
      state: "prelaunch",
      version: 2,
    } as const;
    await fs.writeFile(lockPath, `${JSON.stringify(owner)}\n`);
    await fs.writeFile(`${lockPath}.guard-${owner.ownerId}`, "{partial");
    await expect(
      new DurableFileLock(target, {
        processGuard: "required",
        timeoutMs: 5,
        retryMs: 1,
        hooks: { isPidAlive: () => false },
      }).acquire(),
    ).rejects.toThrow("Storage unavailable");
  });

  it("blocks unsafe persisted descriptors without touching sibling artifacts", async () => {
    const { root, target, lockPath } = await fixture();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "durable-lock-outside-"),
    );
    roots.push(outside);
    const outsideProof = cleanupProof(outside, "e");
    const siblingPending = path.join(
      root,
      "sibling.lock.guard-owner.pending-artifact",
    );
    await fs.writeFile(outsideProof.path, "outside sentinel\n");
    await fs.writeFile(
      siblingPending,
      `${JSON.stringify({ ownerId: "sibling", pid: 999_999_999 })}\n`,
    );
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        ownerId: "../unsafe",
        pid: 999_999_999,
        state: "prelaunch",
        version: 2,
      })}\n`,
    );

    const options = {
      processGuard: "required" as const,
      timeoutMs: 5,
      retryMs: 1,
      hooks: { isPidAlive: () => false },
    };
    await expect(
      new DurableFileLock(target, options).acquire(),
    ).rejects.toThrow("Storage unavailable");
    expect(await fs.readFile(outsideProof.path, "utf8")).toBe(
      "outside sentinel\n",
    );
    expect(await fs.readFile(siblingPending, "utf8")).toContain("sibling");

    const owner = {
      ownerId: "old-absolute-guard",
      pid: 999_999_999,
      state: "prelaunch",
      version: 2,
    } as const;
    await fs.writeFile(lockPath, `${JSON.stringify(owner)}\n`);
    await fs.writeFile(
      `${lockPath}.guard-${owner.ownerId}`,
      `${JSON.stringify({
        ownerId: owner.ownerId,
        version: 1,
        pid: 999_999_998,
        cleanupProof: outsideProof,
      })}\n`,
    );
    await expect(
      new DurableFileLock(target, options).acquire(),
    ).rejects.toThrow("Storage unavailable");
    expect(await fs.readFile(outsideProof.path, "utf8")).toBe(
      "outside sentinel\n",
    );
    expect(await fs.readFile(siblingPending, "utf8")).toContain("sibling");
  });

  it.skipIf(process.platform === "win32")(
    "rejects proof paths through escaping parents and final symlinks",
    async () => {
      const { root, target, lockPath } = await fixture();
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "durable-lock-outside-"),
      );
      roots.push(outside);
      const release = await new DurableFileLock(target, {
        processGuard: "required",
      }).acquire();
      const escapingParent = path.join(root, "escaping-parent");
      await fs.symlink(outside, escapingParent, "dir");
      await expect(
        release.protectProcess({
          pid: process.pid,
          cleanupProof: {
            ...cleanupProof(root, "f"),
            path: path.join(escapingParent, `cleanup-${"f".repeat(32)}.json`),
          },
        }),
      ).rejects.toThrow("Storage unavailable");
      await release();

      const outsideSentinel = path.join(outside, "proof-sentinel.json");
      await fs.writeFile(
        outsideSentinel,
        `${JSON.stringify({ status: "complete", token: "a".repeat(64) })}\n`,
      );
      const linkedProof = cleanupProof(root, "a");
      await fs.symlink(outsideSentinel, linkedProof.path);
      const owner = {
        ownerId: "symlinked-proof",
        pid: 999_999_999,
        state: "prelaunch",
        version: 2,
      } as const;
      await fs.writeFile(lockPath, `${JSON.stringify(owner)}\n`);
      await fs.writeFile(
        `${lockPath}.guard-${owner.ownerId}`,
        `${JSON.stringify({
          ownerId: owner.ownerId,
          version: 2,
          pid: 999_999_998,
          cleanupProof: storedProof(root, linkedProof),
        })}\n`,
      );
      await expect(
        new DurableFileLock(target, {
          processGuard: "required",
          timeoutMs: 5,
          retryMs: 1,
          hooks: { isPidAlive: () => false },
        }).acquire(),
      ).rejects.toThrow("Storage unavailable");
      expect(await fs.readFile(outsideSentinel, "utf8")).toContain("complete");
    },
  );

  it("serializes protection with release and never acknowledges a late permit", async () => {
    const { root, target, lockPath } = await fixture();
    const published = deferred();
    const resume = deferred();
    const release = await new DurableFileLock(target, {
      processGuard: "required",
      hooks: {
        afterProtectionPublished: async () => {
          published.resolve();
          await resume.promise;
        },
      },
    }).acquire();
    const protecting = release.protectProcess({
      pid: process.pid,
      cleanupProof: cleanupProof(root, "b"),
    });
    await published.promise;
    const releasing = release();
    resume.resolve();
    await expect(protecting).rejects.toThrow("Storage unavailable");
    await releasing;
    await expect(
      release.protectProcess({
        pid: process.pid,
        cleanupProof: cleanupProof(root, "c"),
      }),
    ).rejects.toThrow("Storage unavailable");
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rereads a newly published guard under the reclaim claim", async () => {
    const { root, target, lockPath } = await fixture();
    const owner = {
      ownerId: "racing",
      pid: 999_999_999,
      state: "prelaunch",
      version: 2,
    } as const;
    await fs.writeFile(lockPath, `${JSON.stringify(owner)}\n`);
    let changed = false;
    let rejectedRename = 0;
    await expect(
      new DurableFileLock(target, {
        processGuard: "required",
        timeoutMs: 10,
        retryMs: 1,
        hooks: {
          isPidAlive: () => false,
          beforeReclaimRename: async () => {
            if (changed) return;
            changed = true;
            await fs.writeFile(
              `${lockPath}.guard-${owner.ownerId}`,
              `${JSON.stringify({
                ownerId: owner.ownerId,
                version: 2,
                pid: 999_999_998,
                cleanupProof: storedProof(root, cleanupProof(root, "d")),
              })}\n`,
            );
          },
          afterObservedOwnerChanged: () => {
            rejectedRename++;
          },
        },
      }).acquire(),
    ).rejects.toThrow("Storage unavailable");
    expect(changed).toBe(true);
    expect(rejectedRename).toBeGreaterThan(0);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual(owner);
  });

  it("never restores a tombstone over a competing live owner", async () => {
    const { target, lockPath } = await fixture();
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerId: "dead", pid: 999_999_999 })}\n`,
    );
    const renamed = deferred();
    const resume = deferred();
    const reclaiming = new DurableFileLock(target, {
      timeoutMs: 30,
      retryMs: 1,
      hooks: {
        isPidAlive: (pid) => pid === process.pid,
        afterReclaimRename: async () => {
          renamed.resolve();
          await resume.promise;
        },
      },
    }).acquire();
    await renamed.promise;

    let competingOwnerId = "";
    const competingRelease = await new DurableFileLock(target, {
      hooks: {
        afterLockAcquired: (ownerId) => {
          competingOwnerId = ownerId;
        },
      },
    }).acquire();
    resume.resolve();

    await expect(reclaiming).rejects.toThrow("Storage unavailable");
    expect(competingOwnerId).not.toBe("");
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
      ownerId: competingOwnerId,
      pid: process.pid,
    });
    await expect(
      new DurableFileLock(target, {
        timeoutMs: 5,
        retryMs: 1,
      }).acquire(),
    ).rejects.toThrow("Storage unavailable");

    await competingRelease();
  });
});
