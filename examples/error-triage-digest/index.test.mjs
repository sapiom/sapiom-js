import assert from "node:assert/strict";
import test from "node:test";

import { readClusters } from "./index.ts";

const CLUSTER = {
  fingerprint: "timeout-payments-charge",
  title: "Charge timeouts",
  summary: "The charge call times out under load.",
  severity: "high",
  sampleMessage: "ETIMEDOUT POST /charges",
  count: 12,
};

test("reads the forced tool call's clusters", () => {
  assert.deepEqual(readClusters({ clusters: [CLUSTER] }), [CLUSTER]);
});

test("defaults only a missing severity — the entry itself is still real", () => {
  const [cluster] = readClusters({
    clusters: [{ ...CLUSTER, severity: undefined }],
  });
  assert.equal(cluster.severity, "medium");
  assert.equal(cluster.fingerprint, CLUSTER.fingerprint);
});

// ── SAP-2892: an unusable reply must never become a triage result ───────────
//
// The old fallback emitted an `untriaged-batch` cluster titled "Untriaged
// errors" at `medium`, emailed it as a triage result, and PERSISTED that
// fingerprint — so every later failed batch matched it as a *recurring* issue.

test("throws when the response carried no structured clustering", () => {
  assert.throws(() => readClusters(undefined), /no structured clustering/);
  assert.throws(() => readClusters(null), /no structured clustering/);
  assert.throws(
    () => readClusters("I grouped these into three issues..."),
    /no structured clustering/,
  );
});

test("throws rather than emitting a catch-all cluster", () => {
  assert.throws(() => readClusters({}), /no cluster list/);
  assert.throws(() => readClusters({ clusters: [] }), /no usable clusters/);
  // Entries with no fingerprint or title are dropped; nothing left is an error.
  assert.throws(
    () => readClusters({ clusters: [{ summary: "something broke" }] }),
    /no usable clusters/,
  );
});

test("never returns the persisted untriaged-batch fingerprint", () => {
  for (const unusable of [undefined, null, {}, { clusters: [] }]) {
    assert.throws(() => readClusters(unusable));
  }
});
