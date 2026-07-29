import assert from "node:assert/strict";
import test from "node:test";

import { launchChild } from "./index.ts";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("an explicit definition id launches without tenant resolution", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SAPIOM_API_KEY;
  const calls = [];
  process.env.SAPIOM_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ executionId: "child-1" }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await launchChild(
      "child-slug",
      "definition-1",
      { task: "run" },
      null,
      "parent-1",
      logger,
      "idem-1",
    );

    assert.equal(result.executionId, "child-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers["sapiom-scope"], undefined);
    assert.equal(
      calls[0].init.headers["x-sapiom-trace-external-id"],
      "parent-1",
    );
    assert.equal(JSON.parse(calls[0].init.body).definitionId, "definition-1");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SAPIOM_API_KEY;
    else process.env.SAPIOM_API_KEY = originalKey;
  }
});

test("slug resolution still refuses to cross an unknown tenant boundary", async () => {
  const originalKey = process.env.SAPIOM_API_KEY;
  process.env.SAPIOM_API_KEY = "test-key";
  try {
    const result = await launchChild(
      "child-slug",
      undefined,
      {},
      null,
      "parent-1",
      logger,
    );
    assert.equal(result.skipped, "no-tenant-id");
  } finally {
    if (originalKey === undefined) delete process.env.SAPIOM_API_KEY;
    else process.env.SAPIOM_API_KEY = originalKey;
  }
});
