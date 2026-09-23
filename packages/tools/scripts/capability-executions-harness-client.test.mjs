import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { launch } from "./capability-executions-harness-client.mjs";

test("worker control permits a 45-second bootstrap and still bounds missing responses", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "execution-ipc-"));
  const script = path.join(directory, "fixture.mjs");
  await writeFile(
    script,
    `let pending;
process.on("message", (message) => {
  if (message.type === "control") {
    pending = message;
    process.send({ type: "received", action: message.action });
  } else if (message.type === "release") {
    process.send({ type: "response", id: pending.id, result: { started: true } });
  }
});
process.send({ type: "ready" });
`,
  );
  const fixture = launch(script, { execArgv: [] });
  try {
    await fixture.wait((message) => message.type === "ready");
    // Only the parent clock advances: child IPC remains a real process boundary.
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const startup = fixture.control("worker", { state: "start" }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await fixture.wait((message) => message.type === "received");
    context.mock.timers.tick(45_000);
    fixture.send({ type: "release" });
    assert.deepEqual(await startup, { value: { started: true } });

    const ordinaryTimeout = assert.rejects(
      fixture.control("snapshot"),
      /IPC timed out/,
    );
    context.mock.timers.tick(30_001);
    await ordinaryTimeout;

    const workerTimeout = assert.rejects(
      fixture.control("worker", { state: "restart" }),
      /IPC timed out/,
    );
    context.mock.timers.tick(60_001);
    await workerTimeout;
  } finally {
    context.mock.timers.reset();
    await fixture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
