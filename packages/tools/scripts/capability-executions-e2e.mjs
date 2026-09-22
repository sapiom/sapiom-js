/** Real SDK/Core phase gate. Provider effects are controlled only by C07's private harness. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./capability-executions-harness-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(here, "../../..");
const argument = (key) => {
  const i = process.argv.indexOf(key);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Required: ${key} <path>`);
  return path.resolve(process.argv[i + 1]);
};
const backendRoot = argument("--backend-dir");
const evidenceDir = argument("--evidence-dir");
const backend = path.join(backendRoot, "backend");
const harnessFile = path.join(
  backend,
  "test/fixtures/capability-execution-harness.ts",
);
const sdkFile = path.join(here, "capability-executions-sdk-child.mjs");
if (!path.isAbsolute(process.env.CAPABILITY_EXECUTION_TEST_ENV ?? ""))
  throw new Error(
    "CAPABILITY_EXECUTION_TEST_ENV must name the private isolated Core env file.",
  );
await Promise.all([
  access(harnessFile),
  access(process.env.CAPABILITY_EXECUTION_TEST_ENV),
  access(path.join(here, "../dist/esm/index.js")),
]);
const fromBackend = createRequire(path.join(backend, "package.json"));
const sha = (cwd) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const dirty = (cwd) =>
  Boolean(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
    }).trim(),
  );
const evidence = {
  apiFixtureVersion: 1,
  sdkSha: sha(sdkRoot),
  backendSha: sha(backendRoot),
  sdkDirty: dirty(sdkRoot),
  backendDirty: dirty(backendRoot),
  sdkVersion: JSON.parse(
    await readFile(path.join(here, "../package.json"), "utf8"),
  ).version,
  command: process.argv.slice(1),
  startedAt: new Date().toISOString(),
  scenarios: [],
};
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const active = new Set();
let ready;
const harness = launch(harnessFile, {
  cwd: backend,
  env: {
    ...process.env,
    NODE_ENV: "test",
    TS_NODE_PROJECT: path.join(backend, "tsconfig.json"),
    SAPIOM_TELEMETRY_DISABLED: "1",
  },
  execArgv: [
    "-r",
    fromBackend.resolve("ts-node/register/transpile-only"),
    "-r",
    fromBackend.resolve("tsconfig-paths/register"),
  ],
});
active.add(harness);
async function startSdk(operation, args = {}) {
  const child = launch(sdkFile, {
    env: { ...process.env, SAPIOM_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
    execArgv: [],
  });
  active.add(child);
  await child.wait((message) => message.type === "ready");
  child.send({
    operation,
    baseUrl: ready.baseUrl,
    apiKey: ready.apiKey,
    capabilityKey: ready.capabilityKey,
    ...args,
  });
  return child;
}
async function sdk(operation, args = {}) {
  const child = await startSdk(operation, args);
  try {
    const response = await child.wait(
      (message) => ["result", "error"].includes(message.type),
      180_000,
    );
    if (response.type === "error")
      throw Object.assign(new Error(response.error.message), {
        ...response.error,
        history: response.history,
      });
    return response;
  } finally {
    await child.stop();
    active.delete(child);
  }
}
const snapshot = async (executionId) => {
  const raw = await harness.control("snapshot", { executionId });
  assert.equal(raw.execution?.id, executionId);
  const authorizations = raw.authorizations.filter(
    (row) => row.clientRequestId === executionId,
  );
  const ids = new Set(authorizations.map((row) => row.id));
  return {
    ...raw,
    authorizations,
    usage: raw.usage.filter((row) => ids.has(row.authorizationId)),
    providerAttempts: raw.providerAttempts.filter(
      (row) => row.executionId === executionId,
    ),
  };
};
async function assertSnapshot(handle, expectedStatus, maxAttempts = 1) {
  const state = await snapshot(handle.receipt.id);
  assert.equal(state.execution.status, expectedStatus);
  assert.ok(
    Array.isArray(state.providerAttempts),
    "Harness must expose persisted provider attempts",
  );
  assert.ok(
    state.providerAttempts.length <= maxAttempts,
    "Provider work was replayed",
  );
  assert.ok(
    Array.isArray(state.authorizations),
    "Harness must expose real authorization rows",
  );
  assert.ok(Array.isArray(state.usage), "Harness must expose real usage rows");
  assert.ok(
    state.authorizations.length <= 1,
    "Duplicate authorization identity",
  );
  assert.ok(state.usage.length <= 1, "Duplicate usage identity");
  if (expectedStatus === "succeeded") {
    assert.equal(state.providerAttempts.length, 1);
    assert.equal(state.authorizations.length, 1);
    assert.equal(state.usage.length, 1);
    assert.equal(
      state.authorizations[0].status,
      "settled",
      "Successful execution must finalize actual local billing",
    );
    assert.equal(state.usage[0].kind, "settle");
    assert.equal(Number(state.usage[0].amount), 1);
  }
  return state;
}
async function scenario(name, run) {
  const start = Date.now();
  const record = { name, startedAt: new Date(start).toISOString() };
  evidence.scenarios.push(record);
  try {
    Object.assign(record, await run());
    record.passed = true;
  } catch (error) {
    record.passed = false;
    record.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    record.elapsedMs = Date.now() - start;
    await save();
  }
  console.log(`PASS ${name} (${record.elapsedMs} ms)`);
}
async function save() {
  await writeFile(
    path.join(evidenceDir, "capability-executions-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
}

try {
  ready = await harness.wait((message) => message.type === "ready", 60_000);
  assert.equal(ready.apiVersion, 1);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(ready.baseUrl).hostname,
    ),
  );
  evidence.runtimeSettings = ready.runtimeSettings;
  assert.ok(
    ready.runtimeSettings && Object.keys(ready.runtimeSettings).length,
    "Harness runtime settings are required evidence",
  );
  await harness.control("admission", { enabled: true });
  await scenario("startup-roundtrip", async () => {
    const response = await sdk("submitAndWait", {
      request: { value: "startup" },
    });
    assert.deepEqual(response.result.result, { value: "startup" });
    return {
      sdk: response,
      snapshot: await assertSnapshot(response.result.handle, "succeeded"),
    };
  });
  await scenario("long-result-real-elapsed", async () => {
    const start = Date.now();
    const response = await sdk("submitAndWait", {
      request: { value: "long", delayMs: 90_050 },
      waitOptions: { waitTimeoutMs: 150_000 },
    });
    assert.ok(
      Date.now() - start >= 90_000,
      "Long gate must use actual elapsed time",
    );
    assert.deepEqual(response.result.result, { value: "long" });
    return {
      sdk: response,
      snapshot: await assertSnapshot(response.result.handle, "succeeded"),
    };
  });
  await scenario("lost-receipt-same-key-recovery", async () => {
    const response = await sdk("submitAndWait", {
      request: { value: "lost-receipt" },
      dropFirstSubmitResponse: true,
    });
    const posts = response.history.filter(
      (request) => request.method === "POST",
    );
    assert.equal(posts.length, 2);
    assert.equal(posts[0].submissionKey, posts[1].submissionKey);
    assert.equal(posts[0].bodyHash, posts[1].bodyHash);
    assert.equal(posts[0].receiptDropped, true);
    return {
      sdk: response,
      snapshot: await assertSnapshot(response.result.handle, "succeeded"),
    };
  });
  await scenario("caller-process-kill-and-resume", async () => {
    const accepted = await sdk("submit", {
      request: { value: "resumed", delayMs: 2000 },
    });
    const abandoned = await startSdk("wait", {
      handle: accepted.result.handle,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    abandoned.child.kill("SIGKILL");
    await abandoned.stop();
    active.delete(abandoned);
    const resumed = await sdk("wait", { handle: accepted.result.handle });
    assert.deepEqual(resumed.result, { value: "resumed" });
    assert.ok(resumed.history.every((request) => request.method === "GET"));
    return {
      submission: accepted.result,
      sdk: resumed,
      snapshot: await assertSnapshot(accepted.result.handle, "succeeded"),
    };
  });
  await scenario(
    "outbox-publication-recovery-and-duplicate-delivery",
    async () => {
      await harness.control("delivery", { enabled: false });
      const accepted = await sdk("submit", { request: { value: "outbox" } });
      const queued = await snapshot(accepted.result.handle.receipt.id);
      assert.equal(queued.execution.status, "queued");
      assert.equal(queued.providerAttempts.length, 0);
      await harness.control("delivery", { enabled: true });
      await harness.control("duplicate", {
        executionId: accepted.result.handle.receipt.id,
      });
      const result = await sdk("wait", { handle: accepted.result.handle });
      const replay = await sdk("get", {
        executionId: accepted.result.handle.receipt.id,
      });
      assert.deepEqual(replay.result.result, result.result);
      return {
        submission: accepted.result,
        sdk: result,
        before: queued,
        snapshot: await assertSnapshot(accepted.result.handle, "succeeded"),
      };
    },
  );
  for (const checkpoint of [
    "pre_dispatch",
    "dispatch_started",
    "provider_received",
    "outcome_ready",
    "local_finalization",
    "terminal_commit",
  ]) {
    await scenario(`worker-kill-${checkpoint}`, async () => {
      await harness.control("barrier", { checkpoint, enabled: true });
      const accepted = await sdk("submit", { request: { value: checkpoint } });
      await harness.wait(
        (message) =>
          message.type === "barrier" &&
          message.checkpoint === checkpoint &&
          message.executionId === accepted.result.handle.receipt.id,
      );
      const before = await snapshot(accepted.result.handle.receipt.id);
      await harness.control("worker", { state: "kill" });
      await harness.control("barrier", { checkpoint, enabled: false });
      await harness.control("worker", { state: "restart" });
      let result;
      const uncertain = ["dispatch_started", "provider_received"].includes(
        checkpoint,
      );
      if (uncertain) {
        try {
          await sdk("wait", { handle: accepted.result.handle });
          assert.fail("Ambiguous execution was replayed");
        } catch (error) {
          assert.equal(error.name, "ExecutionIndeterminateError");
          result = {
            error: { name: error.name, executionId: error.executionId },
            history: error.history,
          };
        }
      } else result = await sdk("wait", { handle: accepted.result.handle });
      const final = await assertSnapshot(
        accepted.result.handle,
        uncertain ? "indeterminate" : "succeeded",
      );
      if (uncertain) {
        assert.equal(
          final.providerAttempts.length,
          checkpoint === "provider_received" ? 1 : 0,
        );
        assert.equal(final.authorizations.length, 1);
        assert.equal(final.usage.length, 1);
        assert.equal(final.authorizations[0].status, "allowed");
        assert.equal(
          final.authorizations[0].recoveryOwner,
          "capability_execution",
        );
        assert.equal(final.usage[0].kind, "settle");
        assert.equal(Number(final.usage[0].amount), 1);
      }
      if (checkpoint !== "pre_dispatch")
        assert.equal(
          final.providerAttempts.length,
          before.providerAttempts.length,
        );
      const replay = await sdk("get", {
        executionId: accepted.result.handle.receipt.id,
      });
      const afterReplay = await snapshot(accepted.result.handle.receipt.id);
      assert.deepEqual(afterReplay.providerAttempts, final.providerAttempts);
      assert.deepEqual(afterReplay.usage, final.usage);
      return {
        submission: accepted.result,
        sdk: result,
        before,
        snapshot: final,
        replay: replay.result,
      };
    });
  }
  await scenario("admission-off-accepted-job-continuity", async () => {
    await harness.control("worker", { state: "stop" });
    const accepted = await sdk("submit", {
      request: { value: "accepted-before-off" },
    });
    await harness.control("admission", { enabled: false });
    const replay = await sdk("submit", {
      submission: accepted.result.submission,
    });
    assert.equal(
      replay.result.handle.receipt.id,
      accepted.result.handle.receipt.id,
    );
    try {
      await sdk("submit", { request: { value: "new-rejected" } });
      assert.fail("Fresh admission unexpectedly enabled");
    } catch (error) {
      assert.equal(error.status, 503);
      assert.equal(error.code, "admission_disabled");
    }
    await harness.control("worker", { state: "start" });
    const result = await sdk("wait", { handle: accepted.result.handle });
    assert.deepEqual(result.result, { value: "accepted-before-off" });
    const completedReplay = await sdk("submit", {
      submission: accepted.result.submission,
    });
    assert.equal(completedReplay.result.handle.receipt.status, "succeeded");
    return {
      submission: accepted.result,
      sdk: result,
      snapshot: await assertSnapshot(accepted.result.handle, "succeeded"),
    };
  });
  evidence.exitCode = 0;
} catch (error) {
  evidence.exitCode = 1;
  evidence.error = { name: error.name, message: error.message };
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await save();
  try {
    await harness.control("shutdown");
  } catch {
    /* Force cleanup below. */
  }
  await Promise.all([...active].map((child) => child.stop()));
}
