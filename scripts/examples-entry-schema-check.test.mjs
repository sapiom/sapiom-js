// =============================================================================
// scripts/examples-entry-schema-check.test.mjs
//
// Fixture tests for the `entry-schema` gate. The rule: a manifest's renderable
// projection (`defaultInput` / `settings`) may only name paths the code's entry
// `inputSchema` declares. These fixtures pin both the static key extraction and
// the conservative skip behaviour (a parser limitation must never false-fail).
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEntrySchemaCoverage,
  extractEntrySchema,
} from "./examples-entry-schema-check.mjs";

/** A source file whose entry step `run` declares an object-literal inputSchema. */
const source = (schemaBody, { entry = "start", withSchema = true } = {}) => `
import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

const entryInput = z.object({${schemaBody}});

const ${entry} = defineStep({
  name: "${entry}",
  next: ["finish"],
${withSchema ? "  inputSchema: entryInput,\n" : ""}  async run(input, ctx) {
    return goto("finish", {});
  },
});

export const agent = defineAgent({ name: "x", entry: "${entry}", steps: { ${entry} } });
`;

test("extractEntrySchema reads top-level keys of the entry z.object", () => {
  const s = extractEntrySchema(
    source(`
      topic: z.string().default("x"),
      deliverTo: z.string().optional(),
      client: z.object({ email: z.string().optional() }).optional(),
    `),
  );
  assert.equal(s.hasInputSchema, true);
  assert.deepEqual([...s.keys].sort(), ["client", "deliverTo", "topic"]);
});

test("nested object keys are NOT treated as top-level", () => {
  const s = extractEntrySchema(
    source(
      `client: z.object({ email: z.string(), name: z.string() }).optional(),`,
    ),
  );
  assert.deepEqual([...s.keys], ["client"]);
  assert.ok(!s.keys.has("email"));
});

test("no inputSchema on the entry step → hasInputSchema false", () => {
  const s = extractEntrySchema(
    source(`topic: z.string(),`, { withSchema: false }),
  );
  assert.equal(s.hasInputSchema, false);
  assert.equal(s.keys, null);
});

test("settings + defaultInput covered by the schema → no errors", () => {
  const src = source(`
    topic: z.string().default("x"),
    deliverTo: z.string().optional(),
    client: z.object({ email: z.string().optional() }).optional(),
  `);
  const manifest = {
    settings: [
      { path: "deliverTo", label: "To", type: "email", default: "" },
      { path: "client.email", label: "Client", type: "email", default: "" },
    ],
    defaultInput: { topic: "hello" },
  };
  assert.deepEqual(checkEntrySchemaCoverage("fixture", manifest, src), []);
});

test("settings path not declared by the schema → error", () => {
  const src = source(`topic: z.string().default("x"),`);
  const manifest = {
    settings: [{ path: "deliverTo", label: "To", type: "email", default: "" }],
  };
  const errors = checkEntrySchemaCoverage("fixture", manifest, src);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /settings path "deliverTo" is not declared/);
});

test("defaultInput key not declared by the schema → error", () => {
  const src = source(`topic: z.string().default("x"),`);
  const manifest = { defaultInput: { topic: "hi", ghost: 1 } };
  const errors = checkEntrySchemaCoverage("fixture", manifest, src);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /defaultInput key "ghost" is not declared/);
});

test("nested settings path checks its ROOT segment only", () => {
  // `client` is declared; `client.email` is fine even though the schema does not
  // spell out the nested `email` — the projection targets the `client` field.
  const src = source(
    `client: z.object({ email: z.string().optional() }).optional(),`,
  );
  const manifest = {
    settings: [
      { path: "client.email", label: "C", type: "email", default: "" },
    ],
  };
  assert.deepEqual(checkEntrySchemaCoverage("fixture", manifest, src), []);
});

test("manifest with a projection but NO entry inputSchema → fails", () => {
  const src = source(`topic: z.string(),`, { withSchema: false });
  const manifest = { defaultInput: { topic: "hi" } };
  const errors = checkEntrySchemaCoverage("fixture", manifest, src);
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /declares a defaultInput but its entry step declares no `inputSchema`/,
  );
});

test("no settings and no defaultInput → nothing to check", () => {
  const src = source(`topic: z.string(),`, { withSchema: false });
  assert.deepEqual(checkEntrySchemaCoverage("fixture", {}, src), []);
});

test("unreadable source → conservatively skipped", () => {
  const manifest = { defaultInput: { topic: "hi" } };
  assert.deepEqual(checkEntrySchemaCoverage("fixture", manifest, null), []);
});

test("inputSchema built from a non-literal → coverage skipped, never false-fails", () => {
  // A schema assembled by a call (not a readable `z.object({…})` literal) must
  // not fail the gate — the parser cannot see its keys, so it declines to judge.
  const src = `
import { defineAgent, defineStep, goto } from "@sapiom/agent";
const entryInput = buildSchema();
const start = defineStep({
  name: "start",
  next: ["finish"],
  inputSchema: entryInput,
  async run(input, ctx) { return goto("finish", {}); },
});
export const agent = defineAgent({ name: "x", entry: "start", steps: { start } });
`;
  const s = extractEntrySchema(src);
  assert.equal(s.hasInputSchema, true);
  assert.equal(s.keys, null);
  const manifest = {
    settings: [{ path: "whatever", label: "W", type: "string", default: "" }],
  };
  assert.deepEqual(checkEntrySchemaCoverage("fixture", manifest, src), []);
});
