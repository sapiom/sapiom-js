import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PULL_REQUEST_WORKFLOWS = [
  ".github/workflows/test.yml",
  ".github/workflows/harness.yml",
];

function readWorkflow(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("pull request CI uses unprivileged fork-safe triggers", () => {
  for (const relativePath of PULL_REQUEST_WORKFLOWS) {
    const workflow = readWorkflow(relativePath);

    assert.match(workflow, /^  pull_request:\s*$/m, relativePath);
    assert.doesNotMatch(workflow, /pull_request_target:/, relativePath);
    assert.match(
      workflow,
      /^permissions:\n  contents: read\s*$/m,
      relativePath,
    );
    assert.doesNotMatch(
      workflow,
      /(?:^|\s)(?:write-all|[\w-]+: write)\s*$/m,
      relativePath,
    );
    assert.doesNotMatch(workflow, /secrets\./, relativePath);
    assert.doesNotMatch(
      workflow,
      /\b(?:GITHUB_TOKEN|github\.token)\b/,
      relativePath,
    );
  }
});

test("pull request CI cancels superseded revisions and bounds every job", () => {
  for (const relativePath of PULL_REQUEST_WORKFLOWS) {
    const workflow = readWorkflow(relativePath);
    const jobCount = countMatches(workflow, /^    runs-on:/gm);
    const runners = [...workflow.matchAll(/^    runs-on:\s*(.+)\s*$/gm)].map(
      ([, runner]) => runner.trim(),
    );
    const timeouts = [
      ...workflow.matchAll(/^    timeout-minutes:\s*(\d+)\s*$/gm),
    ].map(([, timeout]) => Number.parseInt(timeout, 10));

    assert.match(
      workflow,
      /group: [^\n]*github\.event\.pull_request\.number[^\n]*github\.ref/,
      relativePath,
    );
    assert.match(workflow, /cancel-in-progress: true/, relativePath);
    assert.deepEqual(
      [...new Set(runners)],
      ["ubuntu-latest"],
      `${relativePath}: only standard ephemeral runners are allowed`,
    );
    assert.equal(
      timeouts.length,
      jobCount,
      `${relativePath}: every job needs a timeout`,
    );
    assert.ok(
      timeouts.every((timeout) => timeout <= 20),
      `${relativePath}: job timeouts must remain at most 20 minutes`,
    );
  }
});

test("pull request CI pins actions and disables checkout credentials", () => {
  for (const relativePath of PULL_REQUEST_WORKFLOWS) {
    const workflow = readWorkflow(relativePath);
    const actionUses = [
      ...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm),
    ].map(([, action]) => action);
    const checkoutCount = actionUses.filter((action) =>
      action.startsWith("actions/checkout@"),
    ).length;

    assert.ok(actionUses.length > 0, `${relativePath}: expected actions`);
    for (const action of actionUses) {
      assert.match(
        action,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${relativePath}: ${action}`,
      );
    }
    assert.equal(
      countMatches(workflow, /^\s+persist-credentials: false\s*$/gm),
      checkoutCount,
      `${relativePath}: every checkout must disable persisted credentials`,
    );
  }
});
