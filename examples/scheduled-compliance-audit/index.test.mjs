import assert from "node:assert/strict";
import test from "node:test";

import { readReport } from "./index.ts";

const CHECK = {
  id: "policy-tls",
  requirement: "All public endpoints serve TLS 1.2 or higher.",
  status: "pass",
  evidence: "The scraped headers report TLS 1.3.",
};

const REPORT = {
  status: "compliant",
  summary: "Every requirement is evidenced by the collected state.",
  checks: [CHECK],
};

test("reads the forced tool call's report", () => {
  const report = readReport(REPORT);
  assert.equal(report.status, "compliant");
  assert.equal(report.checks.length, 1);
});

test("carries a remediation through on a failing check", () => {
  const [check] = readReport({
    ...REPORT,
    status: "non_compliant",
    checks: [{ ...CHECK, status: "fail", remediation: "Disable TLS 1.0." }],
  }).checks;
  assert.equal(check.remediation, "Disable TLS 1.0.");
});

// ── SAP-2892: an unusable reply must never become a compliance verdict ──────
//
// `needs_review` looks like a safe default and is not one: it is a verdict, a
// human signs it, and it is archived as an attestation. "The auditor returned
// no usable report" used to be filed under the same status as a genuine
// borderline finding, with an empty check list, on a `succeeded` run.

test("throws when the response carried no structured report", () => {
  assert.throws(() => readReport(undefined), /no structured report/);
  assert.throws(() => readReport(null), /no structured report/);
  assert.throws(
    () => readReport("Everything looks compliant to me."),
    /no structured report/,
  );
});

test("throws rather than defaulting the status to needs_review", () => {
  assert.throws(
    () => readReport({ summary: "s", checks: [CHECK] }),
    /no usable overall status/,
  );
  assert.throws(
    () => readReport({ ...REPORT, status: "probably_fine" }),
    /no usable overall status/,
  );
});

test("throws rather than attesting to an empty check list", () => {
  assert.throws(() => readReport({ ...REPORT, checks: [] }), /no checks/);
  assert.throws(
    () => readReport({ ...REPORT, checks: [{ status: "pass" }] }),
    /no checks/,
  );
});

test("throws rather than substituting a summary", () => {
  assert.throws(
    () => readReport({ ...REPORT, summary: " " }),
    /no audit summary/,
  );
});

test("still accepts needs_review when the model actually chose it", () => {
  assert.equal(
    readReport({ ...REPORT, status: "needs_review" }).status,
    "needs_review",
  );
});
