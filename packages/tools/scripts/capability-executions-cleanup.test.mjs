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
        saveFailure,
        shutdownFailure,
        childFailure,
      ]);
      return true;
    },
  );
  assert.deepEqual(calls, ["save", "shutdown", "first", "second"]);
});
