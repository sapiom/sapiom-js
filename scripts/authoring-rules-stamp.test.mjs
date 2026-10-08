import assert from "node:assert/strict";
import test from "node:test";

import { restamp } from "./lib/authoring-rules-stamp.mjs";

const next = { release: "1.1", digest: "abcdefabcdef" };

test("moves the Markdown stamp and the prose release together", () => {
  const before =
    "This copy was written against release 1.0 of it.\n\n<!-- sapiom-authoring-rules release=1.0 digest=1f3e5cd9648f -->\n";
  assert.equal(
    restamp(before, next),
    "This copy was written against release 1.1 of it.\n\n<!-- sapiom-authoring-rules release=1.1 digest=abcdefabcdef -->\n",
  );
});

test("moves both agent-core constants", () => {
  const before =
    'export const AUTHORING_RULES_RELEASE = "1.0";\nexport const AUTHORING_RULES_DIGEST = "1f3e5cd9648f";\n';
  assert.equal(
    restamp(before, next),
    'export const AUTHORING_RULES_RELEASE = "1.1";\nexport const AUTHORING_RULES_DIGEST = "abcdefabcdef";\n',
  );
});

test("leaves a file with nothing to stamp unchanged", () => {
  const before = "# Working in this agent\n\nNo stamp here.\n";
  assert.equal(restamp(before, next), before);
});

test("leaves a scaffold template's placeholder for scaffold to fill", () => {
  const before =
    "This file was written against release __AUTHORING_RULES_RELEASE__ of that text.\n\n<!-- sapiom-authoring-rules -->\n";
  assert.equal(restamp(before, next), before);
});
