// =============================================================================
// scripts/examples-copy-check.test.mjs
//
// Fixture tests for the house-style copy rules a JSON Schema `pattern` could
// reject but could not explain. The length caps are schema
// `maxLength` and are covered in examples-manifest-check.test.mjs.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MECHANISM_WORDS,
  checkCopy,
  checkRegisteredProjectCopyAsset,
  isRegisteredProjectCopyAsset,
  isRegisteredProjectCopyPathIgnored,
} from "./examples-copy-check.mjs";

/** A template whose copy is clean, plus whatever the case under test overrides. */
const template = { id: "fixture", name: "Account Research Brief" };
const manifest = {
  whatItDoes:
    "Create a cited account brief, relationship graph, and review-ready next actions from live and internal sources.",
};

const check = (t = {}, m = {}) =>
  checkCopy({ ...template, ...t }, { ...manifest, ...m });

test("copy taken straight from the card passes", () => {
  assert.deepEqual(check(), []);
});

test("an arrow or a slash in a name fails", () => {
  for (const name of ["Scene → Images → Video", "Proposal / Quote Generator"]) {
    const errors = check({ name });
    assert.equal(errors.length, 1, `${name} → ${errors.join("; ")}`);
    assert.match(errors[0], /^copy-name: "fixture" /);
    assert.match(errors[0], /contains an arrow or a slash/);
  }
});

test("a parenthetical fails, and is pointed at tags", () => {
  const errors = check({ name: "Approval Chain (Saga)" });
  // Both rules fire — "Saga" is exactly the case that motivated each of them.
  assert.equal(errors.length, 2);
  assert.match(errors[0], /carries a parenthetical/);
  assert.match(errors[1], /mechanism word "Saga"/);
  for (const e of errors) assert.match(e, /`tags`/);
});

test("every mechanism word is caught, case-insensitively", () => {
  for (const word of MECHANISM_WORDS) {
    const errors = check({ name: `Thing ${word}` });
    assert.equal(errors.length, 1, `${word} → ${errors.join("; ")}`);
    assert.match(errors[0], /is built on the mechanism word/);
  }
});

test("plain-English product words are left alone", () => {
  // The denylist is narrow on purpose: a buyer reads these as English, not as
  // machinery, and over-flagging would just make the gate hated.
  for (const name of [
    "PR Review Bot",
    "Newsletter Autopilot",
    "Company News Roundup",
  ]) {
    assert.deepEqual(check({ name }), [], name);
  }
});

test("a mechanism word inside a longer word is not a match", () => {
  // "Engine" must not fire on "Engineering", nor "gate" on "Aggregate".
  for (const name of ["Engineering Digest", "Aggregate Report"]) {
    assert.deepEqual(check({ name }), [], name);
  }
});

test('whatItDoes opening with "For" fails', () => {
  const errors = check(
    {},
    { whatItDoes: "For turning a noisy error stream into one digest." },
  );
  assert.deepEqual(errors, [
    `copy-what-it-does: "fixture" whatItDoes opens with "For" — lead with the verb ("Create a cited account brief…"), not with who it is for.`,
  ]);
});

test("human-readable Workflow terminology fails in nested registry and manifest copy", () => {
  const errors = check(
    { steps: [{ description: "Launch a child workflow." }] },
    { notes: "This workflow pauses until the run resumes." },
  );

  assert.equal(errors.length, 2);
  assert.match(
    errors[0],
    /^copy-terminology: "fixture" registry\.steps\[0\]\.description /,
  );
  assert.match(errors[1], /^copy-terminology: "fixture" manifest\.notes /);
  for (const error of errors) {
    assert.match(
      error,
      /Agent for the deployable definition and Agent run for an execution/,
    );
  }
});

test("registry and manifest prose reject orchestration while the mechanism tag remains valid", () => {
  const errors = check(
    {
      description: "Fan out work through a child orchestration.",
      tags: ["orchestration"],
    },
    { notes: "This orchestration pauses until its child agent run completes." },
  );

  assert.equal(errors.length, 2);
  assert.match(
    errors[0],
    /^copy-terminology: "fixture" registry\.description /,
  );
  assert.match(errors[1], /^copy-terminology: "fixture" manifest\.notes /);
  assert.deepEqual(check({ tags: ["orchestration"] }), []);
});

test("compatibility API routes and tool identifiers stay exact", () => {
  assert.deepEqual(
    check(
      { description: "Calls /v1/workflows/templates and /api/workflows." },
      {
        notes:
          "Resume the agent run with workflow_signal or signal_workflow; sapiom_workflow_run stays available.",
      },
    ),
    [],
  );
});

test("compatibility identifiers do not hide surrounding Workflow prose", () => {
  const errors = check(
    {},
    { notes: "Use workflow_signal to resume this workflow." },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^copy-terminology: "fixture" manifest\.notes /);
});

test("registered project authoring and source assets reject orchestration terminology", () => {
  const errors = checkRegisteredProjectCopyAsset(
    template,
    "examples/fixture/index.ts",
    [
      "// The agent fans out one child run per item.",
      'const input = z.string().describe("Deployed orchestration slug");',
      "// Orchestrations resume after every child completes.",
      "// This workflow pauses while a child runs.",
    ].join("\n"),
  );

  assert.equal(errors.length, 3);
  assert.match(
    errors[0],
    /^copy-project-terminology: "fixture" examples\/fixture\/index\.ts:2 /,
  );
  assert.match(errors[0], /human-readable "orchestration" terminology/i);
  assert.match(errors[1], /index\.ts:3 .*"Orchestrations" terminology/);
  assert.match(errors[2], /index\.ts:4 .*"workflow" terminology/);
});

test("registered project asset scope includes authored prose and source only", () => {
  for (const assetPath of [
    "README.md",
    "AGENTS.md",
    "index.ts",
    "lib/render.mts",
    "public/index.html",
    "styles/main.css",
    "package.json",
  ]) {
    assert.equal(isRegisteredProjectCopyAsset(assetPath), true, assetPath);
  }

  for (const assetPath of [
    "index.test.ts",
    "fixture.test.d.ts",
    "index.spec.mjs",
    "test/upload-sink.mjs",
    "tests/fixture.ts",
    "node_modules/dependency/index.js",
    "dist/index.js",
    "build/index.js",
    "coverage/report.txt",
    "package-lock.json",
    "pnpm-lock.yaml",
    "image.png",
  ]) {
    assert.equal(isRegisteredProjectCopyAsset(assetPath), false, assetPath);
  }
  assert.equal(isRegisteredProjectCopyPathIgnored("src/contest.ts"), false);
});

test("registered project terminology check preserves compatibility identifiers", () => {
  assert.deepEqual(
    checkRegisteredProjectCopyAsset(
      template,
      "examples/fixture/index.ts",
      [
        "workflow_signal",
        "signal_workflow",
        "sapiom_workflow_run",
        "/v1/workflows/templates",
      ].join("\n"),
    ),
    [],
  );
});

test("registered project copy rejects blanket Local Run cost and network guarantees", () => {
  const errors = checkRegisteredProjectCopyAsset(
    template,
    "examples/fixture/AGENTS.md",
    [
      "- `run_local` executes the real step code against stub capabilities,",
      "  so the whole agent runs offline for free.",
    ].join("\n"),
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0], /^copy-local-run-boundary: "fixture" /);
  assert.match(errors[0], /authored code and its side effects still execute/);
});

test("registered project copy accepts the precise Local Run boundary", () => {
  assert.deepEqual(
    checkRegisteredProjectCopyAsset(
      template,
      "examples/fixture/AGENTS.md",
      [
        "- `run_local` executes the real step code with Sapiom capabilities stubbed.",
        "  Keep ordinary network, file, and process effects behind `dryRun`; the",
        "  trace creates no Sapiom capability spend.",
      ].join("\n"),
    ),
    [],
  );
});

test("manifest copy uses the same precise Local Run boundary", () => {
  const errors = check(
    {},
    {
      notes:
        "Run it locally with `run_local` to trace the whole graph for free.",
    },
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^copy-local-run-boundary: "fixture" manifest\.notes:1 /,
  );
});

test("registered project copy accepts the implemented Run Inspector signal form", () => {
  const errors = checkRegisteredProjectCopyAsset(
    template,
    "examples/fixture/README.md",
    "Click **Resume run** in Run Inspector to deliver the signal.",
  );

  assert.deepEqual(errors, []);
});

test("manifest copy accepts the implemented Run Inspector signal form", () => {
  const errors = check(
    {},
    { notes: "Use **Resume run** in Run Inspector to deliver the signal." },
  );

  assert.deepEqual(errors, []);
});

test("registered project copy rejects unavailable generic Run Inspector controls", () => {
  const errors = checkRegisteredProjectCopyAsset(
    template,
    "examples/fixture/README.md",
    "Click **Cancel run** in Run Inspector to stop the execution.",
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0], /^copy-unsupported-control: "fixture" /);
  assert.match(errors[0], /generic run control/);
});

test("manifest copy rejects the same unavailable generic control", () => {
  const errors = check(
    {},
    { notes: "Use **Retry run** in Run Inspector after a failure." },
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0], /^copy-unsupported-control: "fixture" /);
});

test("compatibility literals do not hide surrounding deployable prose", () => {
  const errors = checkRegisteredProjectCopyAsset(
    template,
    "examples/fixture/index.ts",
    [
      "Use workflow_signal to resume this workflow.",
      "Call /v1/workflows/templates, then this orchestration launches a child run.",
    ].join("\n"),
  );

  assert.equal(errors.length, 2);
  assert.match(errors[0], /human-readable "workflow" terminology/);
  assert.match(errors[1], /human-readable "orchestration" terminology/);
});

test("private registry plumbing is outside the visible-copy check", () => {
  assert.deepEqual(
    check({
      id: "workflow-starter",
      sourcePath: "examples/workflow-starter",
      capabilities: ["workflow.dispatch"],
    }),
    [],
  );
});

test("registered template launch guidance names the Agents page", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../examples/registry.json", import.meta.url), "utf8"),
  );
  const launchNotes = registry.templates.flatMap((entry) => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(`../${entry.sourcePath}/template.json`, import.meta.url),
        "utf8",
      ),
    );
    return typeof manifest.notes === "string" &&
      manifest.notes.includes("Click **Use this template**")
      ? [[entry.id, manifest.notes]]
      : [];
  });

  assert.ok(launchNotes.length > 0, "expected registered launch guidance");
  for (const [id, notes] of launchNotes) {
    assert.match(
      notes,
      /open it on the \*\*Agents\*\* page and run it/,
      `${id} must point users at the Agents page`,
    );
  }
});

test('"Format" is not "For" — the rule is word-boundary aware', () => {
  assert.deepEqual(
    check({}, { whatItDoes: "Format the digest and email it." }),
    [],
  );
});

test("whatItDoes is read from the manifest, not the registry entry", () => {
  // It moved out of registry.json in SAP-2076. A stale copy left on the registry
  // entry must not satisfy the rule, or the migration could silently half-apply.
  assert.deepEqual(
    check({ whatItDoes: "For turning…" }, { whatItDoes: "Create a brief." }),
    [],
  );
});

test("a missing manifest is tolerated, not a crash", () => {
  assert.deepEqual(checkCopy(template, null), []);
});

test("missing copy fields are tolerated — the schemas own required-ness", () => {
  assert.deepEqual(checkCopy({ id: "bare" }, {}), []);
});
