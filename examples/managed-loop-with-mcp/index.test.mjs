import assert from "node:assert/strict";
import test from "node:test";

import { mcpFor, parseMcpUrl, readInput, readRun } from "./index.ts";

const DEEPWIKI = "https://mcp.deepwiki.com/mcp";
const MINE = "https://mcp.example.com/mcp";

// ── Entry input: malformed values become a readable rejection ───────────────

test("readInput defaults an omitted server to DeepWiki, or to MCP_URL when set", () => {
  assert.equal(readInput({}, undefined).mcpUrl, DEEPWIKI);
  assert.equal(readInput({}, MINE).mcpUrl, MINE);
  assert.equal(readInput({ mcpUrl: DEEPWIKI }, MINE).mcpUrl, DEEPWIKI);
});

test("readInput rejects a non-string or non-https server instead of failing the run", () => {
  for (const mcpUrl of [
    null,
    42,
    {},
    "http://localhost:8080/mcp",
    "not a url",
  ]) {
    const read = readInput({ mcpUrl }, undefined);
    assert.equal(read.ok, false, `mcpUrl ${JSON.stringify(mcpUrl)}`);
    assert.match(read.reason, /absolute https URL/);
  }
});

test("readInput rejects a non-string question", () => {
  const read = readInput({ question: 7 }, undefined);
  assert.equal(read.ok, false);
  assert.match(read.reason, /`question` must be a string/);
});

test("parseMcpUrl never hands a non-string to the URL parser", () => {
  assert.equal(parseMcpUrl(undefined), null);
  assert.equal(parseMcpUrl(null), null);
  assert.equal(parseMcpUrl(` ${MINE} `), MINE);
});

// ── The bearer token goes only to the configured server ─────────────────────

test("mcpFor sends the token to the MCP_URL origin", () => {
  assert.deepEqual(mcpFor(MINE, "tok", MINE), {
    url: MINE,
    headers: { authorization: "Bearer tok" },
  });
});

test("mcpFor never sends the token to a server the caller chose", () => {
  assert.deepEqual(mcpFor("https://attacker.example/mcp", "tok", MINE), {
    url: "https://attacker.example/mcp",
  });
  assert.deepEqual(mcpFor(DEEPWIKI, "tok", undefined), { url: DEEPWIKI });
});

test("mcpFor sends no header without a token", () => {
  assert.deepEqual(mcpFor(MINE, undefined, MINE), { url: MINE });
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
