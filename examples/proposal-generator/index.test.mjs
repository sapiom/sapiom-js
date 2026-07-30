import assert from "node:assert/strict";
import test from "node:test";

import { agent, buildReadPdfCommand, buildRenderCommand } from "./index.ts";

// The render step lays render.mjs + proposal.json under a per-attempt directory
// and then runs node there. Blaxel's process runtime executes from the workspace
// root and ignores the SDK `cwd` option, so the directory change has to live in
// the command string — otherwise `node render.mjs` resolves against `/blaxel`
// and dies with `Cannot find module '/blaxel/render.mjs'` (SAP-2201).

test("render command cd's into the attempt dir before installing and rendering", () => {
  const cmd = buildRenderCommand("render-a1");

  // The cd must come first, and node must run after it in the same command.
  assert.match(cmd, /^cd render-a1 &&/);
  assert.match(cmd, /npm install\b.*\bpdf-lib@/);
  assert.match(cmd, /&& node render\.mjs$/);
});

test("render command honours a custom pdf package while keeping the cd", () => {
  const cmd = buildRenderCommand("render-a2", "pdf-lib@2.0.0");

  assert.match(cmd, /^cd render-a2 &&/);
  assert.ok(cmd.includes("pdf-lib@2.0.0"));
});

test("read command cd's into the attempt dir before reading the pdf bytes", () => {
  const cmd = buildReadPdfCommand("render-a1", "Q-257-A0.pdf");

  assert.match(cmd, /^cd render-a1 &&/);
  // -w0 first, plain base64 as the fallback for busybox/macOS coreutils.
  assert.ok(cmd.includes("base64 -w0 Q-257-A0.pdf"));
  assert.ok(cmd.includes("base64 Q-257-A0.pdf"));
});

/** Minimal sandbox double that records every command handed to `exec`. */
function recordingBox(execCalls) {
  return {
    async exec(command, opts) {
      execCalls.push({ command, opts });
      // base64 read returns nothing so the render step skips the real upload PUT
      // (the same offline path the step already handles), keeping the test hermetic.
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async destroy() {},
  };
}

function renderContext(execCalls, attempts = 1) {
  const shared = new Map([
    ["draft", { title: "Proposal", lineItems: [] }],
    ["totals", { subtotal: 0, tax: 0, total: 0 }],
    ["currency", "USD"],
    ["quoteNumber", "Q-257-A0"],
  ]);
  return {
    attempts,
    shared: {
      get: (key) => shared.get(key),
      set: (key, value) => shared.set(key, value),
    },
    sapiom: {
      sandboxes: { create: async () => recordingBox(execCalls) },
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

test("render step runs node inside the attempt dir and never relies on a bare cwd option", async () => {
  const execCalls = [];
  const directive = await agent.steps.render.run({}, renderContext(execCalls));

  assert.equal(directive.stepName, "review");

  const renderCall = execCalls.find((c) => c.command.includes("node render.mjs"));
  assert.ok(renderCall, "expected a command that runs node render.mjs");
  // The regression guard: the command itself changes directory. A `cwd` option
  // alone would leave node running in `/blaxel` — the SAP-2201 failure.
  assert.match(renderCall.command, /^cd render-a1 &&/);
  assert.equal(renderCall.opts?.cwd, undefined);
});
