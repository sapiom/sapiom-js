import assert from "node:assert/strict";
import test from "node:test";

import { readDraft } from "./index.ts";

const DRAFT = {
  title: "Payments integration",
  summary: "Wire the new gateway into checkout and reconcile daily.",
  scope: ["Gateway integration", "Daily reconciliation job"],
  lineItems: [
    { description: "Integration build", quantity: 1, unitPrice: 18000 },
    { description: "Reconciliation job", quantity: 1, unitPrice: 6000 },
  ],
  terms: "Valid 30 days. Net 30.",
};

test("reads the forced tool call's draft", () => {
  assert.deepEqual(readDraft(DRAFT), DRAFT);
});

test("an empty scope list is allowed — the money is not", () => {
  assert.deepEqual(readDraft({ ...DRAFT, scope: [] }).scope, []);
});

// ── SAP-2892: an unusable reply must never become a priced quote ────────────
//
// This draft is rendered to a PDF and sent to a human for approval. The old
// fallback quoted `"Professional services", qty 1, $0` over the first 200
// characters of the request and rendered THAT — so an approver could be asked
// to sign off a price no model ever produced.

test("throws when the response carried no structured proposal", () => {
  assert.throws(() => readDraft(undefined), /no structured proposal/);
  assert.throws(() => readDraft(null), /no structured proposal/);
  assert.throws(
    () => readDraft("Here's a proposal for the payments work..."),
    /no structured proposal/,
  );
});

test("throws rather than quoting invented line items", () => {
  assert.throws(
    () => readDraft({ ...DRAFT, lineItems: [] }),
    /no priced line items/,
  );
  // An item with no description is dropped; nothing left is an error.
  assert.throws(
    () => readDraft({ ...DRAFT, lineItems: [{ quantity: 1, unitPrice: 0 }] }),
    /no priced line items/,
  );
});

test("throws rather than substituting the prose fields", () => {
  assert.throws(() => readDraft({ ...DRAFT, title: "" }), /no proposal title/);
  assert.throws(
    () => readDraft({ ...DRAFT, summary: "  " }),
    /no proposal summary/,
  );
  assert.throws(() => readDraft({ ...DRAFT, terms: "" }), /no proposal terms/);
});

test("never returns the old $0 Professional services line", () => {
  for (const unusable of [undefined, null, {}, { ...DRAFT, lineItems: [] }]) {
    assert.throws(() => readDraft(unusable));
  }
});
