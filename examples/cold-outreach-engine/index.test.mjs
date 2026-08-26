import assert from "node:assert/strict";
import test from "node:test";

import { readOpeners } from "./index.ts";

test("reads the forced tool call's openers, keyed by prospect index", () => {
  assert.deepEqual(
    readOpeners({
      lines: [
        { i: 0, firstLine: "Your changelog reads like a product roadmap." },
        { i: 1, firstLine: "Shipping a public status page took nerve." },
      ],
    }),
    {
      0: "Your changelog reads like a product roadmap.",
      1: "Shipping a public status page took nerve.",
    },
  );
});

test("drops an entry with no opener text rather than emailing a blank line", () => {
  assert.deepEqual(
    readOpeners({
      lines: [
        { i: 0, firstLine: "Real opener." },
        { i: 1, firstLine: "   " },
      ],
    }),
    { 0: "Real opener." },
  );
});

// ── SAP-2892: an unusable reply must never become a cold email ──────────────
//
// These lines are emailed to real prospects. The old code swallowed the model
// error entirely and fell every contact back to
// "I've been following what your team is building" — exactly the generic
// flattery the prompt forbids — on a run reported as `succeeded`.

test("throws when the response carried no structured openers", () => {
  assert.throws(() => readOpeners(undefined), /no structured openers/);
  assert.throws(() => readOpeners(null), /no structured openers/);
  assert.throws(
    () => readOpeners("Here are the openers:\n1. Hi there..."),
    /no structured openers/,
  );
});

test("throws rather than falling the batch back to a canned greeting", () => {
  assert.throws(() => readOpeners({}), /no opener list/);
  assert.throws(() => readOpeners({ lines: [] }), /no usable openers/);
  assert.throws(
    () => readOpeners({ lines: [{ i: -1, firstLine: "x" }] }),
    /no usable openers/,
  );
});

test("an entry with no prospect index is dropped, not filed as prospect 0", () => {
  // `Number(null)` is `0`, so a coercing check would hand this line to prospect
  // 0 — a real person, who gets emailed it.
  assert.throws(
    () => readOpeners({ lines: [{ i: null, firstLine: "Real opener." }] }),
    /no usable openers/,
  );
  assert.deepEqual(
    readOpeners({
      lines: [
        { i: null, firstLine: "Belongs to nobody." },
        { i: 1, firstLine: "Belongs to prospect 1." },
      ],
    }),
    { 1: "Belongs to prospect 1." },
  );
});
