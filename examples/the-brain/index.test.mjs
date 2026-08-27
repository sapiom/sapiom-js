import assert from "node:assert/strict";
import test from "node:test";

import { launchChild, readPlan } from "./index.ts";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("an explicit definition id launches without tenant resolution", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SAPIOM_API_KEY;
  const calls = [];
  process.env.SAPIOM_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ executionId: "child-1" }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await launchChild(
      "child-slug",
      "definition-1",
      { task: "run" },
      null,
      "parent-1",
      logger,
      "idem-1",
    );

    assert.equal(result.executionId, "child-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers["sapiom-scope"], undefined);
    assert.equal(
      calls[0].init.headers["x-sapiom-trace-external-id"],
      "parent-1",
    );
    assert.equal(JSON.parse(calls[0].init.body).definitionId, "definition-1");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SAPIOM_API_KEY;
    else process.env.SAPIOM_API_KEY = originalKey;
  }
});

test("slug resolution still refuses to cross an unknown tenant boundary", async () => {
  const originalKey = process.env.SAPIOM_API_KEY;
  process.env.SAPIOM_API_KEY = "test-key";
  try {
    const result = await launchChild(
      "child-slug",
      undefined,
      {},
      null,
      "parent-1",
      logger,
    );
    assert.equal(result.skipped, "no-tenant-id");
  } finally {
    if (originalKey === undefined) delete process.env.SAPIOM_API_KEY;
    else process.env.SAPIOM_API_KEY = originalKey;
  }
});

// ── SAP-2892: an unusable reply must never become a fleet plan ──────────────
//
// The plan LAUNCHES CHILD AGENTS and escalates to people. The old fallback
// synthesized a full plan from the situation kinds and `actuate` executed it —
// so an unparseable reply still spent money launching agents and reported the
// sweep as coordinated. `actuate` re-validating each play bounds the damage; it
// does not make the plan the model's.

const PLAN = {
  plan: [
    { play: "launch_member", target: "ads", reason: "no run today" },
    {
      play: "escalate_to_human",
      target: "billing is stale",
      reason: "no result in 3d",
    },
  ],
  briefing: "Two situations: launched ads, escalated billing.",
  needsHuman: ["billing — no result in 3d"],
};

test("readPlan reads the forced tool call's plan", () => {
  assert.deepEqual(readPlan(PLAN), PLAN);
});

test("readPlan drops a play outside the allow-list rather than passing it through", () => {
  const read = readPlan({
    ...PLAN,
    plan: [{ play: "wire_money", target: "ads", reason: "why not" }],
  });
  assert.deepEqual(read.plan, []);
});

test("readPlan keeps an empty plan with a briefing — 'nothing to do' is an answer", () => {
  const read = readPlan({
    plan: [],
    briefing: "All on cadence.",
    needsHuman: [],
  });
  assert.deepEqual(read.plan, []);
  assert.equal(read.briefing, "All on cadence.");
});

test("readPlan throws when the response carried no structured plan", () => {
  assert.throws(() => readPlan(undefined), /no structured plan/);
  assert.throws(() => readPlan(null), /no structured plan/);
  assert.throws(
    () => readPlan("I'd launch ads and escalate billing."),
    /no structured plan/,
  );
});

test("readPlan throws rather than synthesizing a plan from the situation kinds", () => {
  assert.throws(() => readPlan({ briefing: "b" }), /no plan list/);
  assert.throws(() => readPlan({ plan: PLAN.plan }), /no briefing/);
  assert.throws(
    () => readPlan({ plan: PLAN.plan, briefing: "  " }),
    /no briefing/,
  );
});
