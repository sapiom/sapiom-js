import assert from "node:assert/strict";
import test from "node:test";

import { mcpFor, parseMcpUrl, readInput, readRun } from "./index.ts";

const DEEPWIKI = "https://mcp.deepwiki.com/mcp";
const MINE = "https://mcp.example.com/mcp";

// ── Entry input: an unusable server becomes a readable rejection ────────────

test("readInput defaults an omitted server to DeepWiki", () => {
  assert.equal(readInput({}).mcpUrl, DEEPWIKI);
  assert.equal(readInput({ mcpUrl: MINE }).mcpUrl, MINE);
});

test("readInput rejects a non-https server instead of failing the run", () => {
  for (const mcpUrl of ["http://localhost:8080/mcp", "not a url", ""]) {
    const read = readInput({ mcpUrl });
    assert.equal(read.ok, false, `mcpUrl ${JSON.stringify(mcpUrl)}`);
    assert.match(read.reason, /absolute https URL/);
    assert.equal(read.mcpUrl, mcpUrl);
  }
});

test("readInput falls back to the default question when it is blank", () => {
  const read = readInput({ question: "   " });
  assert.equal(read.ok, true);
  assert.match(read.question, /modelcontextprotocol/);
});

test("parseMcpUrl trims and keeps an https URL", () => {
  assert.equal(parseMcpUrl(` ${MINE} `), MINE);
});

// ── The server gets no credentials ──────────────────────────────────────────

test("mcpFor never attaches headers to a server taken from run input", () => {
  assert.deepEqual(mcpFor("https://attacker.example/mcp"), {
    url: "https://attacker.example/mcp",
  });
});

// ── The result: a failed or empty run is a failure, never an answer ─────────

test("readRun returns the trimmed answer of a completed run", () => {
  assert.deepEqual(
    readRun({
      runId: "r",
      status: "completed",
      output: " hi ",
      result: null,
      error: null,
    }),
    { ok: true, answer: "hi" },
  );
});

test("readRun fails a failed run with its error", () => {
  const read = readRun({
    runId: "r",
    status: "failed",
    output: null,
    result: null,
    error: { message: "mcp server unreachable" },
  });
  assert.deepEqual(read, { ok: false, reason: "mcp server unreachable" });
});

test("readRun fails a completed run with no answer", () => {
  for (const output of [null, "", "   "]) {
    const read = readRun({
      runId: "r",
      status: "completed",
      output,
      result: null,
      error: null,
    });
    assert.deepEqual(read, {
      ok: false,
      reason: "the run completed without an answer",
    });
  }
});
