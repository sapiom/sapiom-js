import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLlmCopySurface,
  checkNoSliceParse,
  checkOneShotLlmTemplate,
} from "./lib/examples-llm-surface.mjs";

function fixture(overrides = {}) {
  return {
    id: "example",
    indexSource: "await ctx.sapiom.llm.run({ request: {} });",
    copySources: [
      { path: "README.md", source: "One-shot calls use ctx.sapiom.llm.run." },
    ],
    packageJson: {
      dependencies: {
        "@sapiom/agent": "^0.12.0",
        "@sapiom/tools": "^0.31.0",
      },
    },
    registryTemplate: {
      capabilities: ["llm.run"],
      steps: [{ name: "write", capability: "llm.run" }],
    },
    ...overrides,
  };
}

test("accepts a gateway-routed one-shot template and matching docs", () => {
  assert.deepEqual(
    checkOneShotLlmTemplate(
      fixture({
        packageJson: {
          dependencies: {
            "@sapiom/agent": "^0.13.0",
            "@sapiom/tools": "^0.32.0",
          },
        },
      }),
    ),
    [],
  );
});

test("accepts dependency ranges exactly at the required SDK floors", () => {
  assert.deepEqual(checkOneShotLlmTemplate(fixture()), []);
});

test("rejects a dependency range below the tools SDK floor", () => {
  const errors = checkOneShotLlmTemplate(
    fixture({
      packageJson: {
        dependencies: {
          "@sapiom/agent": "^0.12.0",
          "@sapiom/tools": "^0.30.0",
        },
      },
    }),
  );

  assert.ok(errors.some((error) => error.includes("@sapiom/tools")));
  assert.ok(!errors.some((error) => error.includes("@sapiom/agent")));
});

test("rejects markdown-emphasized false claims on any copied surface", () => {
  assert.deepEqual(
    checkLlmCopySurface({
      path: "examples/example/AGENTS.md",
      source: "ctx.sapiom.llm does **not** exist.",
    }),
    [
      "llm-surface: examples/example/AGENTS.md falsely says ctx.sapiom.llm does not exist.",
    ],
  );
});

test("rejects the old multi-turn surface and stale copy", () => {
  const errors = checkOneShotLlmTemplate(
    fixture({
      indexSource: "await ctx.sapiom.models.run({ prompt: 'x' });",
      copySources: [
        {
          path: "AGENTS.md",
          source:
            "ctx.sapiom.llm does **not** exist; use ctx.sapiom.models.run.",
        },
      ],
      packageJson: { dependencies: {} },
      registryTemplate: {
        capabilities: ["models.run"],
        steps: [{ name: "write", capability: "models.run" }],
      },
    }),
  );

  assert.ok(errors.some((error) => error.includes("ctx.sapiom.models.run")));
  assert.ok(errors.some((error) => error.includes("falsely says")));
  assert.ok(errors.some((error) => error.includes("@sapiom/tools")));
  assert.ok(errors.some((error) => error.includes("capabilities")));
  assert.ok(errors.some((error) => error.includes('step "write"')));
});

// ── SAP-2892: no template may slice a model reply out of prose ──────────────

test("rejects a first-{-to-last-} slice of a model reply", () => {
  const errors = checkNoSliceParse({
    path: "examples/example/index.ts",
    source: [
      "function parseReview(output) {",
      '  const start = output.indexOf("{");',
      '  const end = output.lastIndexOf("}");',
      "  return JSON.parse(output.slice(start, end + 1));",
      "}",
    ].join("\n"),
  });

  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes("examples/example/index.ts:2"));
  assert.ok(errors[1].includes("examples/example/index.ts:3"));
  for (const error of errors) {
    assert.ok(error.includes("structuredOf"), "names the replacement");
  }
});

test("rejects the array form of the same slice", () => {
  const errors = checkNoSliceParse({
    path: "examples/example/lib/select.ts",
    source:
      'const start = output.indexOf("[");\nconst end = output.lastIndexOf("]");',
  });

  assert.equal(errors.length, 2);
});

test("accepts the blessed structured-output pattern", () => {
  assert.deepEqual(
    checkNoSliceParse({
      path: "examples/example/index.ts",
      source: [
        "const res = await ctx.sapiom.llm.run({",
        "  request: { messages },",
        "  output: { name: REVIEW_TOOL, schema: REVIEW_SCHEMA },",
        "});",
        "const rev = readReview(ctx.sapiom.llm.structuredOf(res, REVIEW_TOOL));",
      ].join("\n"),
    }),
    [],
  );
});

test("leaves JSON that arrived as JSON alone", () => {
  // Parsing an HTTP body, a file, or a stub payload is fine — the defect is
  // slicing a JSON-shaped substring out of a model's prose.
  assert.deepEqual(
    checkNoSliceParse({
      path: "examples/example/index.ts",
      source: [
        "const data = JSON.parse(await res.text());",
        'const sep = url.indexOf("?");',
        'const brace = template.indexOf("{{");',
      ].join("\n"),
    }),
    [],
  );
});
