import assert from "node:assert/strict";
import { it } from "node:test";
import {
  assertStandaloneBrowserInputs,
  assertStandaloneDependencies,
} from "./package-boundaries.mjs";

for (const name of ["@sapiom/harness", "@sapiom/mcp"]) {
  it(`rejects a direct ${name} dependency`, () => {
    assert.throws(
      () =>
        assertStandaloneDependencies([
          { dependencies: { [name]: { from: name } } },
        ]),
      /Forbidden installed dependency/,
    );
  });
  it(`rejects a transitive ${name} installed under an optional alias`, () => {
    assert.throws(
      () =>
        assertStandaloneDependencies([
          {
            dependencies: {
              neutral: { optionalDependencies: { alias: { from: name } } },
            },
          },
        ]),
      /Forbidden installed dependency/,
    );
  });
}

for (const file of [
  "packages/harness/src/index.ts",
  "packages/mcp/src/index.ts",
  "/tmp/node_modules/@sapiom/harness/dist/index.js",
  "C:\\temp\\node_modules\\@sapiom\\mcp\\dist\\index.js",
]) {
  it(`rejects browser input ${file}`, () => {
    assert.throws(
      () => assertStandaloneBrowserInputs([file]),
      /Forbidden browser dependency/,
    );
  });
}

it("accepts the standalone package and neutral dependencies", () => {
  assertStandaloneDependencies([
    { name: "@sapiom/agent-map", dependencies: { zod: { from: "zod" } } },
  ]);
  assertStandaloneBrowserInputs([
    "packages/agent-map/dist/shared/paths.js",
    "/tmp/node_modules/zod/index.js",
  ]);
});
