import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startOpenCodeServer,
  type OpenCodeProcessIdentity,
} from "@sapiom/opencode";
import {
  DurableFileLock,
  type DurableFileLockRelease,
} from "./durable-file-lock.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cancelled-runtime-guard-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it.each(["before-protection", "after-protection-published"])(
  "keeps ownership safe when cancellation precedes late %s completion",
  async (phase) => {
    const lockPath = join(directory, "runtime");
    const entered = deferred(),
      gate = deferred();
    const abort = new AbortController();
    let identity: OpenCodeProcessIdentity | undefined;
    let replacement: DurableFileLockRelease | undefined;
    const release = await new DurableFileLock(lockPath, {
      processGuard: "required",
      hooks:
        phase === "after-protection-published"
          ? {
              afterProtectionPublished: async () => {
                entered.resolve();
                await gate.promise;
              },
            }
          : {},
    }).acquire();
    let outcome: unknown;
    const starting = startOpenCodeServer({
      cwd: directory,
      stateRoot: join(directory, "engine"),
      config: {},
      signal: abort.signal,
      command: {
        executable: process.execPath,
        prefixArgs: [
          fileURLToPath(
            new URL(
              "../../../opencode/src/__fixtures__/server.mjs",
              import.meta.url,
            ),
          ),
        ],
      },
      beforeLaunch: async (nextIdentity) => {
        identity = nextIdentity;
        if (phase === "before-protection") {
          entered.resolve();
          await gate.promise;
        }
        await release.protectProcess(nextIdentity);
      },
    }).then(
      async (runtime) => {
        await runtime.close();
        outcome = { unexpectedStarted: true };
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    try {
      await entered.promise;
      abort.abort();
      await vi.waitFor(
        () => expect(outcome).toMatchObject({ code: "cancelled" }),
        { timeout: 1000 },
      );
      expect(() => process.kill(identity!.pid, 0)).toThrow();
      const proof = JSON.parse(
        await readFile(identity!.cleanupProof.path, "utf8"),
      );
      expect(proof).toEqual({
        status: "complete",
        token: identity!.cleanupProof.token,
      });
      let released = false;
      const releasing = release().then(() => {
        released = true;
      });
      if (phase === "after-protection-published") {
        // Guard publication still owns the lock until its serialized post-write check finishes.
        await expect(
          new DurableFileLock(lockPath, {
            processGuard: "required",
            timeoutMs: 30,
          }).acquire(),
        ).rejects.toThrow();
        expect(released).toBe(false);
        gate.resolve();
        await releasing;
        replacement = await new DurableFileLock(lockPath, {
          processGuard: "required",
        }).acquire();
      } else {
        await releasing;
        replacement = await new DurableFileLock(lockPath, {
          processGuard: "required",
        }).acquire();
        const replacementOwner = await readFile(`${lockPath}.lock`, "utf8");
        gate.resolve();
        await starting;
        // The original release blocks a late protectProcess before it can publish against the new owner.
        await vi.waitFor(async () =>
          expect(await readFile(`${lockPath}.lock`, "utf8")).toBe(
            replacementOwner,
          ),
        );
      }
      await starting;
      expect(
        (await readdir(directory)).some((entry) => entry.includes(".guard-")),
      ).toBe(false);
      await expect(
        readFile(join(directory, "runtime.pid"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      gate.resolve();
      await starting;
      await release();
      await replacement?.();
    }
  },
);
