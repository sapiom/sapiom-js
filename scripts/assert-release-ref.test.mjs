import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("./assert-release-ref.mjs", import.meta.url),
);

function run(event, ref) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref },
  });
}

test("pushes pass: their triggers already restrict the ref", () => {
  assert.equal(run("push", "refs/heads/main").status, 0);
  assert.equal(run("push", "refs/tags/v1.2.3").status, 0);
});

test("a dispatch from main passes", () => {
  assert.equal(run("workflow_dispatch", "refs/heads/main").status, 0);
});

test("a dispatch from any other ref fails with the ref named", () => {
  for (const ref of ["refs/heads/feature/x", "refs/tags/v1.2.3"]) {
    const result = run("workflow_dispatch", ref);
    assert.equal(result.status, 1, ref);
    assert.match(
      result.stderr,
      new RegExp(
        `::error::Release workflows can only be dispatched from main \\(got ${ref}\\)`,
      ),
    );
  }
});
