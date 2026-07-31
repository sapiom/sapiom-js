import assert from "node:assert/strict";
import test from "node:test";

import { agent } from "./index.ts";

// `publish` re-attaches the coding run's execution environment and deploys it.
// `deployPreview` only serves from a Blaxel cloud sandbox; a coding run in local
// host mode leaves its files on the runner host, and attaching that id + deploying
// 404s with "Sandbox not found" (SAP-2203). `publish` must detect the
// non-deployable environment up front and degrade honestly instead of attempting
// a deploy that cannot succeed.

/** A completed coding result whose run used `type`. */
function codingResult(type, id = "research-to-microsite-abc123") {
  return {
    runId: "run-1",
    status: "completed",
    summary: "built the site",
    result: {
      success: true,
      turns: 3,
      modelUsed: "x",
      durationMs: 1,
      toolCallCount: 1,
      usage: {},
    },
    error: null,
    executionEnvironment: { type, id },
  };
}

/** Minimal ctx double. Records sandbox attaches so we can assert none happen. */
function publishContext({ attachCalls = [], deployResult, seed = {} } = {}) {
  const shared = new Map(Object.entries(seed));
  return {
    shared: {
      get: (key) => shared.get(key),
      set: (key, value) => shared.set(key, value),
    },
    sapiom: {
      sandboxes: {
        attach(name) {
          attachCalls.push(name);
          return {
            async deployPreview() {
              return deployResult;
            },
          };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test("publish degrades honestly when the coding run used a local-host environment (SAP-2203)", async () => {
  const attachCalls = [];
  const directive = await agent.steps.publish.run(
    codingResult("local_host", "/tmp/sapiom-coding-runs/runs/abc"),
    publishContext({ attachCalls }),
  );

  // Route to the honest-degrade terminal, carrying the environment type — never
  // to `failed`, and never attempting the deploy that would 404.
  assert.equal(directive.stepName, "builtNotPublished");
  assert.equal(directive.input.environmentType, "local_host");
  assert.deepEqual(
    attachCalls,
    [],
    "must not attach/deploy a non-deployable environment",
  );
});

test("publish deploys and goes live when the coding run used a Blaxel sandbox", async () => {
  const attachCalls = [];
  const directive = await agent.steps.publish.run(
    codingResult("blaxel_sandbox", "research-to-microsite-abc123"),
    publishContext({
      attachCalls,
      deployResult: {
        url: "https://research-to-microsite-abc123.preview.sapiom.ai",
        status: "deployed",
        logs: "",
      },
    }),
  );

  // The production path is unchanged: attach the sandbox, deploy, go live.
  assert.equal(directive.stepName, "live");
  assert.equal(
    directive.input.liveUrl,
    "https://research-to-microsite-abc123.preview.sapiom.ai",
  );
  assert.deepEqual(attachCalls, ["research-to-microsite-abc123"]);
});

test("builtNotPublished is a meaningful terminal that names the local-mode limitation", async () => {
  const directive = await agent.steps.builtNotPublished.run(
    { environmentType: "local_host" },
    publishContext({
      seed: {
        topic: "durable workflow engines",
        reportTitle: "Durable Workflow Engines",
        reportTagline: "Retries, done right.",
        sources: [{ title: "s", url: "https://example.com" }],
        sandboxName: "/tmp/sapiom-coding-runs/runs/abc",
      },
    }),
  );

  assert.equal(directive.kind, "terminate");
  const out = directive.output;
  assert.equal(out.published, false);
  assert.equal(out.built, true);
  assert.equal(out.reason, "non-deployable-environment");
  assert.equal(out.environmentType, "local_host");
  assert.equal(out.title, "Durable Workflow Engines");
  // The note explains this publishes in production — an honest degrade, not a 404.
  assert.match(out.note, /production/i);
});
