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

test("moves the JSDoc pointer's release without touching the URL", () => {
  const before =
    " * https://api.sapiom.ai/v1/agents/authoring-rules#llm-call-surface (written against release 1.0).\n";
  assert.equal(
    restamp(before, next),
    " * https://api.sapiom.ai/v1/agents/authoring-rules#llm-call-surface (written against release 1.1).\n",
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

test("moves a JSDoc pointer whose release wrapped onto the next comment line", () => {
  const before =
    " * https://api.sapiom.ai/v1/agents/authoring-rules#llm-call-surface\n * (written against release 1.0).\n";
  assert.equal(
    restamp(before, next),
    " * https://api.sapiom.ai/v1/agents/authoring-rules#llm-call-surface\n * (written against release 1.1).\n",
  );
});
