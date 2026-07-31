import assert from "node:assert/strict";
import test from "node:test";

import { agent, buildReadPdfCommand, buildRenderCommand } from "./index.ts";

// The render step materializes render.mjs + proposal.json and runs node against
// them. `writeFile` and `exec` hit the same sandbox container but root paths
// differently: the filesystem API is `/blaxel`-rooted AND the SDK prepends
// `workspaceRoot` (also `/blaxel`), so a relative `writeFile` double-nests to
// `/blaxel/blaxel/...`, while `exec` runs at `/blaxel` — the write is never where
// node reads, and it dies with `Cannot find module` (SAP-2201; bug class
// AGENT-231). The fix does everything in one exec: decode the files from base64
// in the same command that runs node — one shell, one cwd, no filesystem-API paths.

test("render command builds+renders in one exec, decoding files from base64", () => {
  const cmd = buildRenderCommand("render-a1", {
    renderScript: "console.log('hi')",
    proposalJson: '{"quoteNumber":"Q-1"}',
  });

  // Single command: make the dir, enter it, write both files, install, run node.
  assert.match(cmd, /^mkdir -p render-a1 && cd render-a1 &&/);
  // Files are decoded from base64 INTO the same dir the exec runs in — never via
  // the separate `writeFile` filesystem API.
  const scriptB64 = Buffer.from("console.log('hi')", "utf8").toString("base64");
  const proposalB64 = Buffer.from('{"quoteNumber":"Q-1"}', "utf8").toString(
    "base64",
  );
  assert.ok(cmd.includes(`printf %s '${scriptB64}' | base64 -d > render.mjs`));
  assert.ok(
    cmd.includes(`printf %s '${proposalB64}' | base64 -d > proposal.json`),
  );
  assert.match(cmd, /npm install\b.*\bpdf-lib@/);
  assert.match(cmd, /&& node render\.mjs$/);
  // render.mjs must be materialized BEFORE node runs.
  assert.ok(cmd.indexOf("> render.mjs") < cmd.indexOf("node render.mjs"));
});

test("render command honours a custom pdf package", () => {
  const cmd = buildRenderCommand(
    "render-a2",
    { renderScript: "x", proposalJson: "{}" },
    "pdf-lib@2.0.0",
  );

  assert.match(cmd, /^mkdir -p render-a2 && cd render-a2 &&/);
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
function recordingBox(calls) {
  return {
    workspaceRoot: "/blaxel",
    async exec(command, opts) {
      calls.exec.push({ command, opts });
      // base64 read returns nothing so the render step skips the real upload PUT
      // (the same offline path the step already handles), keeping the test hermetic.
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    // The whole point of the fix is that we do NOT depend on writeFile; assert it
    // is never called so a regression back to the filesystem API is caught.
    async writeFile() {
      calls.write.push([...arguments]);
    },
    async destroy() {},
  };
}

function renderContext(calls) {
  const shared = new Map([
    ["draft", { title: "Proposal", lineItems: [] }],
    ["totals", { subtotal: 0, tax: 0, total: 0 }],
    ["currency", "USD"],
    ["quoteNumber", "Q-257-A0"],
  ]);
  return {
    attempts: 1,
    shared: {
      get: (key) => shared.get(key),
      set: (key, value) => shared.set(key, value),
    },
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

test("render step materializes files inside the exec and never uses writeFile", async () => {
  const calls = { exec: [], write: [] };
  const directive = await agent.steps.render.run({}, renderContext(calls));

  assert.equal(directive.stepName, "review");

  // The regression guard: files are written by the exec itself, not writeFile.
  assert.equal(calls.write.length, 0, "writeFile must not be used (SAP-2201)");

  const renderCall = calls.exec.find((c) =>
    c.command.includes("node render.mjs"),
  );
  assert.ok(renderCall, "expected a command that runs node render.mjs");
  // Same command creates the dir, writes render.mjs, and runs node — one context.
  assert.match(renderCall.command, /^mkdir -p render-a1 && cd render-a1 &&/);
  assert.ok(renderCall.command.includes("base64 -d > render.mjs"));
});
