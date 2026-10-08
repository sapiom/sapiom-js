import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { launch } from "./capability-executions-harness-client.mjs";

const script = fileURLToPath(
  new URL("./capability-executions-sdk-child.mjs", import.meta.url),
);
const receipt = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  capabilityId: "test.execution",
  status: "queued",
  createdAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-22T00:00:00.000Z",
};
async function child() {
  const process = launch(script, {
    env: {
      ...globalThis.process.env,
      SAPIOM_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    },
    execArgv: [],
  });
  await process.wait((message) => message.type === "ready");
  return process;
}

test("built SDK child rejects a non-loopback fixture destination before attaching credentials", async () => {
  const process = await child();
  try {
    process.send({
      operation: "get",
      baseUrl: "https://example.com",
      apiKey: "fixture-key",
      executionId: receipt.id,
    });
    const result = await process.wait((message) => message.type === "error");
    assert.match(result.error.message, /loopback/);
    assert.deepEqual(result.history, []);
    assert.ok(!JSON.stringify(result).includes("fixture-key"));
  } finally {
    await process.stop();
  }
});

test("built public artifacts recover a lost receipt and resume from a fresh SDK process", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const data of req) body += data;
    requests.push({
      method: req.method,
      path: req.url,
      key: req.headers["idempotency-key"],
      body,
    });
    assert.equal(req.headers["x-api-key"], "fixture-only");
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      res.statusCode = 202;
      res.end(JSON.stringify(receipt));
    } else
      res.end(
        JSON.stringify({
          ...receipt,
          status: "succeeded",
          result: { value: "saved" },
        }),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let process;
  try {
    process = await child();
    process.send({
      operation: "submit",
      baseUrl,
      apiKey: "fixture-only",
      capabilityKey: "test.execution",
      request: { value: "saved" },
      dropFirstSubmitResponse: true,
    });
    const prepared = await process.wait(
      (message) => message.type === "prepared",
    );
    assert.equal(prepared.submission.coreBaseUrl, baseUrl);
    const accepted = await process.wait((message) =>
      ["result", "error"].includes(message.type),
    );
    assert.equal(accepted.type, "result");
    assert.equal(accepted.history.length, 2);
    assert.equal(accepted.history[0].bodyHash, accepted.history[1].bodyHash);
    assert.equal(
      accepted.history[0].submissionKey,
      accepted.history[1].submissionKey,
    );
    assert.equal(accepted.history[0].receiptDropped, true);
    await process.stop();
    process = await child();
    process.send({
      operation: "wait",
      baseUrl,
      apiKey: "fixture-only",
      handle: accepted.result.handle,
    });
    const resumed = await process.wait((message) =>
      ["result", "error"].includes(message.type),
    );
    assert.equal(resumed.type, "result");
    assert.deepEqual(resumed.result, { value: "saved" });
    assert.deepEqual(
      resumed.history.map((request) => request.method),
      ["GET"],
    );
    assert.equal(
      requests.filter((request) => request.method === "POST").length,
      2,
    );
    assert.equal(requests[0].key, requests[1].key);
    assert.equal(requests[0].body, requests[1].body);
    assert.ok(!JSON.stringify([accepted, resumed]).includes("fixture-only"));
  } finally {
    await process?.stop();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("IPC process failure rejects a pending waiter instead of hanging", async () => {
  const process = await child();
  const failure = assert.rejects(
    process.wait((message) => message.type === "never", 1000),
    /Fixture exited/,
  );
  process.child.kill("SIGKILL");
  await failure;
  await process.stop();
});
