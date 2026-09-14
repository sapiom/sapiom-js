import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("release readiness follows the checked-out blocker, independent of cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  const script = join(root, "scripts", "assert-release-ready.mjs");
  await copyFile(
    new URL("./assert-release-ready.mjs", import.meta.url),
    script,
  );
  const run = () =>
    spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(run().status, 0);
  const blocker = join(root, ".release-blocked");
  await writeFile(blocker, "Include the client recovery before release.\n");
  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Release blocked:\nInclude the client recovery/);
  await rm(blocker);
  assert.equal(run().status, 0);
});
