import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupExecutionGate } from "./capability-executions-cleanup.mjs";

test("failed evidence writes still shut down Core and every SDK child", async () => {
  const calls = [];
  const saveFailure = new Error("disk full");
  const shutdownFailure = new Error("Core disconnected");
  const childFailure = new Error("first child failed");
  const operation = (name, error) => async () => {
    calls.push(name);
    if (error) throw error;
  };
  await assert.rejects(
    cleanupExecutionGate(
      operation("save", saveFailure),
      {
        control: operation("shutdown", shutdownFailure),
      },
      new Set([
        { stop: operation("first", childFailure) },
        { stop: operation("second") },
      ]),
    ),
    (error) => {
      assert.deepEqual(error.errors, [
        shutdownFailure,
        childFailure,
        saveFailure,
      ]);
      return true;
    },
  );
  assert.deepEqual(calls, ["shutdown", "first", "second", "save"]);
});

for (const boundary of [undefined, "shutdown", "first", "both"]) {
  test(`final receipt follows every cleanup attempt (${boundary ?? "success"})`, async () => {
    const calls = [];
    const failures = [];
    let receipt;
    const operation = (name) => async () => {
      calls.push(name);
      if (boundary === name || (boundary === "both" && name !== "second")) {
        const error = new Error(`private diagnostic from ${name}`);
        failures.push(error);
        throw error;
      }
    };
    const result = cleanupExecutionGate(
      async (cleanupErrors) => {
        calls.push("save");
        receipt = { cleanupErrors, stopped: calls.includes("second") };
      },
      { control: operation("shutdown") },
      new Set([{ stop: operation("first") }, { stop: operation("second") }]),
    );
    if (boundary) {
      await assert.rejects(result, (error) => {
        assert.deepEqual(error.errors, failures);
        return true;
      });
    } else await result;
    assert.deepEqual(calls, ["shutdown", "first", "second", "save"]);
    assert.equal(receipt.stopped, true);
    assert.deepEqual(
      receipt.cleanupErrors,
      boundary === "both"
        ? ["shutdown", "child_stop"]
        : boundary
          ? [boundary === "shutdown" ? "shutdown" : "child_stop"]
          : [],
    );
    assert.ok(!JSON.stringify(receipt).includes("private diagnostic"));
  });
}
