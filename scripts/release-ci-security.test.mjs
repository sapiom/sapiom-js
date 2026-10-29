import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_WORKFLOWS = [
  ".github/workflows/publish.yml",
  ".github/workflows/desktop-release.yml",
  ".github/workflows/release-pr.yml",
];

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

// Comment lines are prose; the assertions are about what the runner executes.
function withoutCommentLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

// Text of one top-level job, from its `  <name>:` line to the next job.
function job(workflow, name) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `expected a "${name}" job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[\w-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("release workflows pin every action to a commit", () => {
  for (const relativePath of RELEASE_WORKFLOWS) {
    const workflow = withoutCommentLines(read(relativePath));
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length > 0, `${relativePath}: expected actions`);
    for (const [, action, rest] of uses) {
      assert.match(
        action,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${relativePath}: ${action}`,
      );
      assert.match(
        rest,
        /#\s*v\d/,
        `${relativePath}: ${action} needs a version comment`,
      );
    }
  }
});

test("npm publishing holds OIDC only in the main-only, environment-gated job", () => {
  const workflow = withoutCommentLines(read(".github/workflows/publish.yml"));
  const check = job(workflow, "check");
  const publish = job(workflow, "publish");

  assert.equal(count(workflow, /id-token:\s*write/g), 1);
  assert.match(publish, /id-token:\s*write/);
  assert.match(publish, /^ {4}environment: npm-publish$/m);
  assert.match(publish, /^ {4}needs: check$/m);
  assert.match(publish, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /needs\.check\.outputs\.pending == 'true'/);

  assert.doesNotMatch(check, /id-token/);
  assert.match(check, /^ {6}contents: read$/m);
  assert.match(check, /node scripts\/assert-release-ref\.mjs/);
  assert.match(check, /node scripts\/release-pending\.mjs/);
});

test("mcp-publisher is a pinned, checksummed download", () => {
  const workflow = withoutCommentLines(read(".github/workflows/publish.yml"));
  assert.doesNotMatch(workflow, /releases\/latest/);
  assert.match(workflow, /MCP_PUBLISHER_VERSION: \d+\.\d+\.\d+$/m);
  assert.match(workflow, /MCP_PUBLISHER_SHA256: [0-9a-f]{64}$/m);
  assert.match(
    workflow,
    /releases\/download\/v\$\{MCP_PUBLISHER_VERSION\}\/mcp-publisher_linux_amd64\.tar\.gz/,
  );
  const verify = workflow.indexOf("sha256sum -c");
  const extract = workflow.indexOf("tar xzf mcp-publisher.tar.gz");
  assert.ok(verify !== -1 && extract > verify, "verify before extracting");
});

test("desktop signing secrets only reach the environment-gated build job", () => {
  const workflow = withoutCommentLines(
    read(".github/workflows/desktop-release.yml"),
  );
  const prepare = job(workflow, "prepare");
  const build = job(workflow, "build");
  const release = job(workflow, "release");

  assert.match(build, /^ {4}environment: desktop-release$/m);
  assert.ok(count(build, /secrets\./g) > 0);
  assert.equal(count(workflow, /secrets\./g), count(build, /secrets\./g));
  assert.match(prepare, /node scripts\/assert-release-ref\.mjs/);
  assert.match(release, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test("desktop release passes ref names through env, not into scripts", () => {
  const workflow = withoutCommentLines(
    read(".github/workflows/desktop-release.yml"),
  );
  const runBlocks = [
    ...workflow.matchAll(/^( +)run: \|\n((?:\1 {2}[^\n]*\n|\s*\n)*)/gm),
  ].map(([, , body]) => body);
  assert.ok(runBlocks.length > 0);
  for (const body of runBlocks) {
    assert.doesNotMatch(body, /\$\{\{\s*github\.ref_(?:name|type)\s*\}\}/);
  }
  assert.match(workflow, /REF_NAME: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /REF_TYPE: \$\{\{ github\.ref_type \}\}/);
});

test("signing secrets are written to the desktop-release environment", () => {
  const script = read(
    "packages/harness-desktop/scripts/mac-signing-secrets.sh",
  );
  const writes = [...script.matchAll(/gh secret set\b[^\n]*/g)].map(
    ([line]) => line,
  );
  assert.equal(writes.length, 7);
  for (const line of writes) {
    assert.match(line, /gh secret set --env desktop-release /, line);
  }
});
