import assert from "node:assert/strict";
import test from "node:test";

import { readExtraction } from "./index.ts";

const EXTRACTION = {
  contact: {
    name: "Ada Okonkwo",
    email: "ada@acme.test",
    company: "Acme",
    title: "VP Eng",
  },
  update: {
    dealStage: "evaluation",
    nextStep: "Security review on the 14th",
    summary: "Acme wants a security review before signing.",
  },
  actionItems: [
    { description: "Send the SOC 2 report.", owner: "us", dueDate: null },
  ],
};

test("reads the forced tool call's extraction", () => {
  const extraction = readExtraction(EXTRACTION);
  assert.equal(extraction.contact.name, "Ada Okonkwo");
  assert.equal(extraction.actionItems.length, 1);
});

test("keeps an empty action-item list — plenty of calls produce none", () => {
  assert.deepEqual(
    readExtraction({ ...EXTRACTION, actionItems: [] }).actionItems,
    [],
  );
});

// ── SAP-2892: an unusable reply must never become a CRM row ─────────────────
//
// `emptyExtraction()` filed `"Unknown contact"` with no action items against a
// real call, and emailed that as the recap — indistinguishable from a meeting
// where genuinely nothing was agreed.

test("throws when the response carried no structured extraction", () => {
  assert.throws(() => readExtraction(undefined), /no structured extraction/);
  assert.throws(() => readExtraction(null), /no structured extraction/);
  assert.throws(
    () => readExtraction("The call was with Ada from Acme..."),
    /no structured extraction/,
  );
});

test("throws rather than filing the call against Unknown contact", () => {
  assert.throws(
    () => readExtraction({ update: EXTRACTION.update, actionItems: [] }),
    /no contact/,
  );
});

test("throws rather than writing a blank CRM update", () => {
  assert.throws(
    () => readExtraction({ contact: EXTRACTION.contact, actionItems: [] }),
    /no CRM update/,
  );
});

test("throws rather than reporting the call as having no action items", () => {
  assert.throws(
    () => readExtraction({ ...EXTRACTION, actionItems: undefined }),
    /no action-item list/,
  );
});

test("still refuses to guess an email the transcript never stated", () => {
  const extraction = readExtraction({
    ...EXTRACTION,
    contact: { name: "Ada Okonkwo", email: null, company: null, title: null },
  });
  assert.equal(extraction.contact.email, null);
  assert.equal(extraction.contact.company, null);
});
