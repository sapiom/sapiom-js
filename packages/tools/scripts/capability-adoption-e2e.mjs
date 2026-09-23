/** SAP-3565 public-method gate; real Core/worker/billing, controlled external gateways. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./capability-executions-harness-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(here, "../../..");
function argument(key) {
  const index = process.argv.indexOf(key);
  assert.ok(index > 0 && process.argv[index + 1], `Required: ${key} <path>`);
  return path.resolve(process.argv[index + 1]);
}
const backendRoot = argument("--backend-dir");
const evidenceDir = argument("--evidence-dir");
const backend = path.join(backendRoot, "backend");
assert.ok(path.isAbsolute(process.env.CAPABILITY_EXECUTION_TEST_ENV ?? ""));
const fromBackend = createRequire(path.join(backend, "package.json"));
const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const source = (cwd) => ({
  sha: git(cwd, ["rev-parse", "HEAD"]),
  dirty: !!git(cwd, ["status", "--porcelain"]),
});
const evidence = {
  version: 1,
  sdk: source(sdkRoot),
  backend: source(backendRoot),
  startedAt: new Date().toISOString(),
  scenarios: [],
};
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const save = () =>
  writeFile(
    path.join(evidenceDir, "capability-adoption-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
const active = new Set();
let ready;
const harness = launch(
  path.join(backend, "test/fixtures/capability-execution-harness.ts"),
  {
    cwd: backend,
    env: {
      ...process.env,
      NODE_ENV: "test",
      TS_NODE_PROJECT: path.join(backend, "tsconfig.json"),
      CAPABILITY_EXECUTION_TEST_FAMILY: "adoption",
      SAPIOM_TELEMETRY_DISABLED: "1",
    },
    execArgv: [
      "-r",
      fromBackend.resolve("ts-node/register/transpile-only"),
      "-r",
      fromBackend.resolve("tsconfig-paths/register"),
    ],
  },
);
active.add(harness);
async function startSdk(operation, args = {}) {
  const child = launch(path.join(here, "capability-executions-sdk-child.mjs"), {
    env: {
      ...process.env,
      SAPIOM_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      SAPIOM_MEMORY_URL: ready.gatewayBaseUrl,
      SAPIOM_DATABASE_URL: ready.gatewayBaseUrl,
      SAPIOM_DOMAINS_URL: ready.gatewayBaseUrl,
      SAPIOM_FILE_STORAGE_URL: ready.gatewayBaseUrl,
    },
    execArgv: [],
  });
  active.add(child);
  await child.wait((message) => message.type === "ready");
  child.send({
    operation,
    baseUrl: ready.baseUrl,
    apiKey: ready.apiKey,
    ...args,
  });
  return child;
}
async function sdk(operation, args) {
  const child = await startSdk(operation, args);
  try {
    const message = await child.wait(
      (value) => ["result", "error"].includes(value.type),
      150_000,
    );
    assert.equal(
      message.type,
      "result",
      `SDK failed: ${message.error?.name}/${message.error?.code ?? message.error?.status}`,
    );
    return message;
  } finally {
    await child.stop();
    active.delete(child);
  }
}
async function scenario(name, run) {
  const record = { name, startedAt: new Date().toISOString() };
  evidence.scenarios.push(record);
  const start = Date.now();
  try {
    Object.assign(record, await run());
    record.passed = true;
  } catch (error) {
    record.passed = false;
    record.errorType = error.name;
    throw error;
  } finally {
    record.elapsedMs = Date.now() - start;
    await save();
  }
  console.log(`PASS ${name} (${record.elapsedMs} ms)`);
}
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "void")
    .digest("hex");
const wire = (attempt) => ({
  method: attempt.method,
  path: attempt.path,
  request: attempt.request,
});
const snapshot = (id) => harness.control("snapshot", { executionId: id });
const summary = (state) => ({
  executionId: state.execution.id,
  status: state.execution.status,
  providerAttempts: state.providerAttempts.length,
  authorizations: state.authorizations,
  usage: state.usage,
});

try {
  ready = await harness.wait((message) => message.type === "ready", 60_000);
  assert.equal(new URL(ready.baseUrl).hostname, "127.0.0.1");
  assert.equal(new URL(ready.gatewayBaseUrl).hostname, "127.0.0.1");
  evidence.runtimeSettings = ready.runtimeSettings;
  const cases = await harness.control("cases");
  for (const original of cases) {
    const fixture = structuredClone(original);
    if (fixture.capability === "domains.purchase")
      fixture.request.domainName = "example.test";
    const native = fixture.billing === "core-deferred";
    if (native)
      Object.assign(fixture.responses[0].body, {
        status_url: `${ready.gatewayBaseUrl}/native/status`,
        response_url: `${ready.gatewayBaseUrl}/native/result`,
      });
    const variants = native
      ? [
          "launch",
          "wait",
          ...(fixture.capability.endsWith("video") ? ["create"] : []),
        ]
      : ["create"];
    for (const variant of variants)
      await scenario(
        `${fixture.name}/${variant} legacy versus executions`,
        async () => {
          const responses = [...fixture.responses];
          if (variant === "wait" || (native && variant === "create"))
            responses.push({
              path: "/native/result",
              body: fixture.capability.endsWith("video")
                ? {
                    video: {
                      url: "https://output.test/video",
                      content_type: "video/mp4",
                    },
                  }
                : {
                    images: [
                      {
                        url: "https://output.test/image",
                        content_type: "image/png",
                      },
                    ],
                  },
            });
          const observed = [];
          let job;
          for (const capabilityDelivery of ["legacy", "executions"]) {
            await harness.control("provider", { responses });
            const before = (await snapshot()).providerAttempts.length;
            const result = await sdk("capability", {
              capabilityKey: fixture.capability,
              request: fixture.request,
              capabilityDelivery,
              verb: variant === "create" ? "create" : "launch",
              waitForNative: variant === "wait",
            });
            const after = await snapshot();
            const attempts = after.providerAttempts.slice(before);
            assert.equal(attempts.length, responses.length);
            observed.push({ result: result.result, wire: attempts.map(wire) });
            if (capabilityDelivery === "executions") {
              const submissions = result.history.filter(
                (request) => request.method === "POST",
              );
              assert.equal(submissions.length, 1);
              assert.equal(
                submissions[0].path,
                `/v1/capabilities/${fixture.capability}/executions`,
              );
              assert.equal(submissions[0].status, 202);
              const id = attempts[0].executionId;
              job = await snapshot(id);
              assert.equal(job.execution.status, "succeeded");
              assert.equal(
                job.authorizations.length,
                fixture.billing === "gateway" ? 0 : 1,
              );
              if (job.authorizations.length)
                assert.equal(
                  job.authorizations[0].status,
                  native ? "allowed" : "settled",
                );
              const read = await sdk("get", { executionId: id });
              assert.equal(read.result.status, "succeeded");
              assert.equal(
                (await snapshot(id)).providerAttempts.length,
                fixture.responses.length,
              );
            } else
              assert.ok(
                result.history.every(
                  (request) => !request.path.endsWith("/executions"),
                ),
              );
          }
          assert.deepEqual(observed[0], observed[1]);
          return {
            ...summary(job),
            resultHash: hash(observed[1].result),
            comparedProviderRequests: observed[1].wire.length,
          };
        },
      );
  }
  await scenario(
    "deep search lost receipt, caller exit and fresh-process resume over 90 seconds",
    async () => {
      await harness.control("provider", {
        responses: [
          {
            path: "/v1/search",
            delayMs: 45_000,
            status: 429,
            body: { code: "rate_limited" },
          },
          {
            path: "/v1/research",
            delayMs: 47_000,
            body: { output: { content: "slow answer", sources: [] } },
          },
        ],
      });
      const start = Date.now();
      const submitting = await startSdk("submit", {
        capabilityKey: "web.search",
        request: { query: "question", depth: "deep", intent: "answer" },
        dropFirstSubmitResponse: true,
      });
      const accepted = await submitting.wait(
        (message) => message.type === "result",
        10_000,
      );
      assert.ok(Date.now() - start < 10_000);
      assert.equal(accepted.history.length, 2);
      assert.equal(
        accepted.history[0].submissionKey,
        accepted.history[1].submissionKey,
      );
      await submitting.stop();
      active.delete(submitting);
      await harness.control("admission", { enabled: false });
      await harness.control("duplicate", {
        executionId: accepted.result.handle.receipt.id,
      });
      const resumed = await sdk("wait", {
        handle: accepted.result.handle,
        waitOptions: { waitTimeoutMs: 120_000 },
      });
      assert.deepEqual(resumed.result, {
        query: "question",
        answer: "slow answer",
        results: [],
      });
      assert.ok(resumed.history.every((request) => request.method === "GET"));
      assert.ok(Date.now() - start > 90_000);
      const state = await snapshot(accepted.result.handle.receipt.id);
      assert.equal(state.providerAttempts.length, 2);
      assert.equal(state.authorizations.length, 1);
      assert.equal(state.authorizations[0].status, "settled");
      assert.equal(state.usage.length, 1);
      return {
        ...summary(state),
        acceptanceMs:
          new Date(accepted.result.handle.receipt.createdAt).valueOf() - start,
        submissionKey: accepted.history[0].submissionKey,
        resultHash: hash(resumed.result),
        resumedWithReadsOnly: true,
      };
    },
  );
  evidence.passed = true;
} finally {
  try {
    await harness.control("shutdown");
  } finally {
    await Promise.allSettled([...active].map((child) => child.stop()));
    evidence.completedAt = new Date().toISOString();
    await save();
  }
}
