import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditRepository,
  auditSources,
} from "./agent-studio-terminology-check.mjs";

const fixturePath = "fixtures/visible-copy.tsx";

function source(content, kind = "code", sourcePath = fixturePath) {
  return { path: sourcePath, kind, content };
}

function allowed(id, pattern, occurrences = 1) {
  return {
    id,
    path: fixturePath,
    pattern,
    occurrences,
    reason: "Fixture for an exact compatibility contract.",
  };
}

describe("Agent Studio terminology guard", () => {
  it("rejects a newly introduced visible Workflow phrase", () => {
    const result = auditSources({
      sources: [
        source("export const Empty = () => <p>Create a workflow first.</p>;"),
      ],
    });

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].token, "workflow");
    assert.match(result.violations[0].context, /Create a workflow first/);
  });

  it("ignores source comments and non-rendered type literals or type property names", () => {
    const result = auditSources({
      sources: [
        source(`
          // Old workflow implementation note.
          /* Workflows stay in this source comment for history. */
          type PrivateKind = "launched-workflow";
          interface PrivateShape { "workflow-kind": string }
          export const Visible = () => <p>Agent ready.</p>;
        `),
        source("<!-- Workflow migration note -->\n# Agent Studio", "text"),
      ],
    });

    assert.deepEqual(result.violations, []);
  });

  it("scans runtime string property names and JSON keys", () => {
    const result = auditSources({
      sources: [
        source('export const labels = { "Workflow status": "ready" };'),
        source(
          JSON.stringify({ "Workflow label": "Agent" }),
          "json",
          "fixtures/manifest.json",
        ),
      ],
    });

    assert.equal(result.violations.length, 2);
    assert.deepEqual(
      result.violations.map(({ path }) => path),
      [fixturePath, "fixtures/manifest.json"],
    );
    assert.match(result.violations[1].context, /Workflow label.*key/);
  });

  it("scans mts, cts, and CSS while ignoring CSS comments", () => {
    const result = auditSources({
      sources: [
        source(
          'export const title = "Workflow";',
          "code",
          "fixtures/surface.mts",
        ),
        source('exports.title = "Workflow";', "code", "fixtures/surface.cts"),
        source(
          '/* Workflow migration note. */\n.agent::after { content: "Workflow"; }',
          "text",
          "fixtures/surface.css",
        ),
      ],
    });

    assert.equal(result.violations.length, 3);
    assert.deepEqual(
      result.violations.map(({ path }) => path),
      ["fixtures/surface.mts", "fixtures/surface.cts", "fixtures/surface.css"],
    );
  });

  it("strips YAML comments without hiding quoted values, URL fragments, or block scalars", () => {
    const result = auditSources({
      sources: [
        source(
          [
            "# Workflow full-line comment",
            "name: Agent # Workflow inline comment",
            'double: "Agent # Workflow quoted value"',
            "single: 'Agent # Workflow quoted value'",
            "url: https://example.test/#workflow",
            "body: |",
            "  # Workflow rendered heading",
            "  Agent body",
            "run: |",
            "  echo Agent # Workflow shell comment",
            '  echo "Agent # Workflow quoted shell output"',
          ].join("\n"),
          "text",
          "fixtures/release.yml",
        ),
      ],
    });

    assert.equal(result.violations.length, 5);
    assert.deepEqual(
      result.violations.map(({ line }) => line),
      [3, 4, 5, 7, 11],
    );
  });

  it("allows every documented compatibility-literal category", () => {
    const result = auditSources({
      sources: [
        source(`
          export const compatibility = [
            "/v1/workflows",
            "/api/workflows",
            "sapiom_workflow_run",
            "workflow_signal",
            "signal_workflow",
            "workflow.run",
            "workflows.changed",
            "workflows.json",
            "{{workflow.path}}",
            "boundWorkflow",
            "launched-workflow",
            "workflow-row",
            "Workflow",
            "@sapiom/harness",
            "sapiom-harness",
            "ai.sapiom.harness",
            "harness-desktop-v0.1.4",
          ];
        `),
      ],
      allowlist: [
        allowed("backend-route", "^/v1/workflows$"),
        allowed("local-route", "^/api/workflows$"),
        allowed("mcp-tool", "^sapiom_workflow_run$"),
        allowed("signal-tool", "^workflow_signal$"),
        allowed("legacy-signal-tool", "^signal_workflow$"),
        allowed("analytics-event", "^workflow\\.run$"),
        allowed("event-name", "^workflows\\.changed$"),
        allowed("state-file", "^workflows\\.json$"),
        allowed("macro-placeholder", "^\\{\\{workflow\\.path\\}\\}$"),
        allowed("legacy-context-key", "^boundWorkflow$"),
        allowed("canvas-node-kind", "^launched-workflow$"),
        allowed("css-id", "^workflow-row$"),
        allowed("icon-id", "^Workflow$"),
      ],
    });

    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.unusedAllowlist, []);
  });

  it("does not let an approved route hide surrounding product prose", () => {
    const result = auditSources({
      sources: [
        source('export const copy = "/api/workflows is the workflow gallery";'),
      ],
      allowlist: [allowed("local-route", "/api/workflows")],
    });

    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0].context, /workflow gallery/);
    assert.deepEqual(result.unusedAllowlist, []);
  });

  it("fails when an allowlist entry is stale after its literal is removed", () => {
    const result = auditSources({
      sources: [source('export const label = "Agent";')],
      allowlist: [allowed("local-route", "^/api/workflows$")],
    });

    assert.deepEqual(result.violations, []);
    assert.equal(result.unusedAllowlist.length, 1);
    assert.equal(result.unusedAllowlist[0].used, 0);
    assert.equal(result.unusedAllowlist[0].occurrences, 1);
  });

  it("fails when an allowlisted literal's exact occurrence count changes", () => {
    const result = auditSources({
      sources: [source('export const route = "/api/workflows";')],
      allowlist: [allowed("local-route", "^/api/workflows$", 2)],
    });

    assert.deepEqual(result.violations, []);
    assert.equal(result.unusedAllowlist.length, 1);
    assert.equal(result.unusedAllowlist[0].used, 1);
    assert.equal(result.unusedAllowlist[0].occurrences, 2);
  });

  it("keeps the repository-owned scope and allowlist in sync", async () => {
    const result = await auditRepository();

    assert.ok(result.files.length > 300);
    assert.ok(result.files.includes(".github/workflows/desktop-release.yml"));
    assert.ok(
      result.files.includes("packages/harness-desktop/src/preload/desktop.mts"),
    );
    assert.ok(result.files.includes("packages/harness/web/src/styles.css"));
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.unusedAllowlist, []);
  });
});
