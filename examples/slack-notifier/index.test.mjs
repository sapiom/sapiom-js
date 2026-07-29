import assert from "node:assert/strict";
import test from "node:test";

import { agent, postViaBot, postViaWebhook } from "./index.ts";

test("bot mode uses the injected metered fetch and keeps the token in a header", async () => {
  const calls = [];
  const meteredFetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({ ok: true, channel: "C123", ts: "123.456" }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const result = await postViaBot(
    meteredFetch,
    "xoxb-secret",
    "C123",
    "hello",
    null,
  );

  assert.deepEqual(result, { channel: "C123", ts: "123.456" });
  assert.equal(calls[0].input, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].init.headers.Authorization, "Bearer xoxb-secret");
});

test("webhook mode uses native fetch for the secret-bearing URL", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response("ok");
  };

  try {
    const webhook =
      "https://hooks.slack.com/services/T00000000/B00000000/secret-value";
    await postViaWebhook(webhook, "hello", "Sapiom");
    assert.equal(calls[0].input, webhook);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      text: "hello",
      username: "Sapiom",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the webhook workflow branch does not require a Sapiom metering key", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebhook = process.env.SLACK_WEBHOOK_URL;
  const originalApiKey = process.env.SAPIOM_API_KEY;
  const webhook =
    "https://hooks.slack.com/services/T00000000/B00000000/secret-value";
  process.env.SLACK_WEBHOOK_URL = webhook;
  delete process.env.SAPIOM_API_KEY;
  globalThis.fetch = async () => new Response("ok");
  const state = new Map([
    ["dryRun", false],
    ["via", "webhook"],
    ["channel", null],
    ["message", "hello"],
    ["username", null],
  ]);
  const ctx = {
    executionId: "execution-1",
    shared: {
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };

  try {
    const directive = await agent.steps.post.run({}, ctx);
    assert.equal(directive.kind, "continue");
    assert.equal(directive.stepName, "posted");
    assert.equal(directive.input.posted, true);
    assert.equal(directive.input.via, "webhook");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = originalWebhook;
    if (originalApiKey === undefined) delete process.env.SAPIOM_API_KEY;
    else process.env.SAPIOM_API_KEY = originalApiKey;
  }
});
