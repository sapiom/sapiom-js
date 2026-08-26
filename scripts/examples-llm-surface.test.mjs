import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLlmCopySurface,
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
