import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { DurableFileLock } from "./durable-file-lock.js";

describe("DurableFileLock", () => {
  it("serializes live owners and reclaims a proven-dead owner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-lock-"));
    const target = path.join(root, "state.json");
    const first = new DurableFileLock(target);
    const release = await first.acquire();
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
      `${target}.lock`,
      `${JSON.stringify({ ownerId: "dead", pid: 999_999_999 })}\n`,
    );
    await (
      await new DurableFileLock(target, {
        hooks: { isPidAlive: () => false },
      }).acquire()
    )();
    await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.rm(root, { recursive: true, force: true });
  });
});
