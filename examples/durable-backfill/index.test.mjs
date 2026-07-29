import assert from "node:assert/strict";
import test from "node:test";

import { sandboxName } from "./index.ts";

test("sandbox names stay within Blaxel's limit and preserve retry identity", () => {
  const name = sandboxName(`${"segment-".repeat(12)}tail`, 1200, 3);

  assert.ok(name.length <= 49);
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(name.endsWith("-a3"));
  assert.equal(name.includes("--"), false);
});
