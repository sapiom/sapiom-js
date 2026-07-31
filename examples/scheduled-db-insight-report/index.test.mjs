import assert from "node:assert/strict";
import test from "node:test";

import { agent } from "./index.ts";

// The chart step materializes render.mjs + data.json and runs node against them.
// `writeFile` and `exec` root paths differently on the Blaxel sandbox (SAP-2209:
// the filesystem API and the SDK both prepend the workspace root, so a `writeFile`d
// file double-nests to `/blaxel/blaxel/...` while `exec` runs at `/blaxel`) — the
// write is never where node reads it, and the chart silently degrades out. The fix
// materializes the files from base64 inside the same exec that runs node, and reads
// the SVG back over the exec channel too (readFile would double-nest identically).

const SERIES_METRICS = [
  {
    name: "Rows per table",
    kind: "series",
    points: [
      { label: "events", value: 81_300 },
      { label: "users", value: 12_840 },
    ],
  },
];

/**
 * Sandbox double that records exec commands and flags any writeFile/readFile use.
 * The render exec returns success; the read exec returns a base64 SVG so the step
 * walks the upload path (proving the read is decoded, not `readFile`d).
 */
function recordingBox(calls) {
  return {
    workspaceRoot: "/blaxel",
    async exec(command) {
      calls.exec.push(command);
      if (command.includes("base64 -w0 chart.svg")) {
        // the read-back: hand back a base64-encoded SVG over the exec channel.
        const svg = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
        return {
          exitCode: 0,
          stdout: Buffer.from(svg, "utf8").toString("base64"),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    // The fix must not touch the filesystem API — assert these are never called.
    async writeFile() {
      calls.write.push([...arguments]);
    },
    async readFile() {
      calls.read.push([...arguments]);
    },
    async destroy() {},
  };
}

function chartContext(calls) {
  return {
    executionId: "test-exec-1",
    sapiom: {
      sandboxes: { create: async () => recordingBox(calls) },
      fileStorage: {
        upload: async () => ({
          fileId: "file-1",
          uploadUrl: "https://upload.invalid",
          requiredHeaders: {},
        }),
        getDownloadUrl: async (fileId) => ({
          downloadUrl: `https://download.invalid/${fileId}`,
        }),
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test("chart step materializes files + reads the SVG entirely over exec, never the FS API", async () => {
  const calls = { exec: [], write: [], read: [] };
  const directive = await agent.steps.chart.run(
    { metrics: SERIES_METRICS },
    chartContext(calls),
  );

  // It reached deliver with a hosted chart URL (the render + read round-tripped).
  assert.equal(directive.stepName, "deliver");
  assert.ok(
    directive.input?.chartUrl,
    "expected a chartUrl from the rendered SVG",
  );

  // The regression guard: no filesystem-API calls — everything goes through exec.
  assert.equal(calls.write.length, 0, "writeFile must not be used (SAP-2209)");
  assert.equal(calls.read.length, 0, "readFile must not be used (SAP-2209)");

  // The render exec decodes both inputs from base64, in one command, before node.
  const renderCmd = calls.exec.find((c) => c.includes("node render.mjs"));
  assert.ok(renderCmd, "expected an exec that runs node render.mjs");
  assert.ok(renderCmd.includes("base64 -d > render.mjs"));
  assert.ok(renderCmd.includes("base64 -d > data.json"));
  assert.ok(
    renderCmd.indexOf("> render.mjs") < renderCmd.indexOf("node render.mjs"),
    "render.mjs must be materialized before node runs",
  );

  // The SVG is read back over the exec channel, not readFile.
  assert.ok(calls.exec.some((c) => c.includes("base64 -w0 chart.svg")));
});

test("chart step skips the sandbox entirely when there is nothing chartable", async () => {
  const calls = { exec: [], write: [], read: [] };
  const directive = await agent.steps.chart.run(
    { metrics: [{ name: "count", kind: "scalar", value: 5 }] },
    chartContext(calls),
  );
  assert.equal(directive.stepName, "deliver");
  assert.equal(directive.input?.chartUrl, null);
  assert.equal(calls.exec.length, 0, "no sandbox work when no series metric");
});
