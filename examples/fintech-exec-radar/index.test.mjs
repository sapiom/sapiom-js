import assert from "node:assert/strict";
import test from "node:test";

import { zodToJsonSchema } from "@sapiom/agent";
import { EmailHttpError } from "@sapiom/tools";

import { agent } from "./index.ts";

function sharedStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    has: (key) => values.has(key),
    snapshot: () => Object.fromEntries(values),
  };
}

function logger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function rankedLlm(orderedIndexes = []) {
  return {
    id: "rank-test",
    type: "message",
    role: "assistant",
    model: "stub-model",
    content: [
      {
        type: "tool_use",
        name: "rank_fintech_radar_items",
        input: { orderedIndexes },
      },
    ],
    stop_reason: "end_turn",
  };
}

function rankingClient(orderedIndexes = [], capture) {
  return {
    async run(spec) {
      capture?.(spec);
      return rankedLlm(orderedIndexes);
    },
    structuredOf(response, name) {
      return response.content.find(
        (block) => block.type === "tool_use" && block.name === name,
      )?.input;
    },
  };
}

function item(company) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    key: `${slug}|exec_moves|https://news.example/${slug}`,
    company,
    signal: "exec_moves",
    headline: `${company} names a new executive`,
    url: `https://news.example/${slug}`,
    date: null,
    direction: "arrival",
    evidence: `A sourced report covers an executive move at ${company}.`,
  };
}

async function acknowledgeReportedItems(context, child) {
  return agent.steps.deliver.run(
    {
      runDate: "2026-08-26",
      coverage: { requested: 1, covered: 1, failed: [] },
      newItems: child.summaryItems.length,
      digest: "# Digest",
      items: child.summaryItems,
      children: [
        {
          company: child.company,
          status: "completed",
          executionId: "child-1",
          ok: child.ok,
          persisted: child.persisted,
          dedupeNamespace: child.dedupeNamespace,
          observedItems: child.observedItems,
          newItems: child.newItems,
          failures: child.failures,
        },
      ],
    },
    context,
  );
}

test("entry contract leads with delivery and only requires a watchlist", () => {
  const schema = zodToJsonSchema(agent.steps.plan.inputSchema);

  assert.equal(Object.keys(schema.properties)[0], "deliverTo");
  assert.equal(schema.properties.deliverTo.type, "string");
  assert.equal(schema.properties.deliverTo.default, "");
  assert.equal(schema.properties.deliverTo.format, "email-or-empty");
  assert.equal(typeof schema.properties.deliverTo.pattern, "string");
  assert.equal(schema.properties.window.default, "7d");
  assert.equal(schema.properties.maxScrapesPerCompany.default, 3);
  assert.equal(schema.properties.maxCapabilityCalls.default, 160);
  assert.equal(schema.properties.dryRun.default, true);
  assert.deepEqual(schema.required, ["companies"]);
});

test("three failed children still produce a 12-of-15 sourced digest", async () => {
  const companies = Array.from(
    { length: 15 },
    (_, index) => `Example Fintech ${String.fromCharCode(65 + index)}`,
  );
  const failed = new Set([
    "Example Fintech A",
    "Example Fintech C",
    "Example Fintech O",
  ]);
  const rows = companies.map((company) =>
    failed.has(company)
      ? {
          ok: false,
          company,
          baseline: false,
          dedupeAvailable: false,
          persisted: false,
          observedItems: 0,
          newItems: 0,
          summaryItems: [],
          failures: ["simulated child failure"],
          status: "failed",
          executionId: `failed-${company}`,
        }
      : {
          ok: true,
          company,
          baseline: true,
          dedupeAvailable: true,
          persisted: true,
          observedItems: 1,
          newItems: 1,
          summaryItems: [item(company)],
          failures: [],
          status: "completed",
          executionId: `completed-${company}`,
        },
  );
  const context = {
    shared: sharedStore({ runDate: "2026-08-26", deliverTo: null }),
    sapiom: { llm: rankingClient() },
    logger: logger(),
  };

  const reduced = await agent.steps.reduce.run({ rows }, context);
  assert.equal(reduced.stepName, "deliver");
  const delivered = await agent.steps.deliver.run(reduced.input, context);

  assert.equal(delivered.output.coverage.requested, 15);
  assert.equal(delivered.output.coverage.covered, 12);
  assert.equal(delivered.output.coverage.failed.length, 3);
  assert.match(
    delivered.output.digest,
    /\*\*Example Fintech A:\*\* simulated child failure/,
  );
  assert.match(
    delivered.output.digest,
    /https:\/\/news\.example\/example-fintech-b/,
  );
  assert.equal(delivered.output.delivered, false);
});

test("digest escapes untrusted Markdown link labels", async () => {
  const sourcedItem = item("Example Fintech B");
  sourcedItem.headline = [
    String.raw`Report ](https://evil.example) \ [draft]`,
    "## Fabricated section",
  ].join("\n\n");
  const context = {
    shared: sharedStore({ runDate: "2026-08-26", deliverTo: null }),
    sapiom: { llm: rankingClient() },
    logger: logger(),
  };

  const reduced = await agent.steps.reduce.run(
    {
      rows: [
        {
          ok: true,
          company: "Example Fintech B",
          baseline: false,
          dedupeAvailable: true,
          persisted: true,
          observedItems: 1,
          newItems: 1,
          summaryItems: [sourcedItem],
          failures: [
            "funding search failed: timeout\n\n## Fabricated coverage gap",
          ],
          status: "completed",
          executionId: "completed-example-b",
        },
      ],
    },
    context,
  );

  assert.ok(
    reduced.input.digest.includes(
      String.raw`[Report \](https://evil.example) \\ \[draft\] ## Fabricated section](<https://news.example/example-fintech-b>)`,
    ),
  );
  assert.doesNotMatch(reduced.input.digest, /^## Fabricated section$/m);
  assert.doesNotMatch(reduced.input.digest, /^## Fabricated coverage gap$/m);
  assert.equal(reduced.input.items[0].headline, sourcedItem.headline);
});

test("digest includes only requested signals and excludes uncovered findings", async () => {
  const uncoveredItem = item("Failed Co");
  const context = {
    shared: sharedStore({
      runDate: "2026-08-26",
      signals: ["funding"],
      deliverTo: null,
    }),
    sapiom: { llm: rankingClient() },
    logger: logger(),
  };

  const reduced = await agent.steps.reduce.run(
    {
      rows: [
        {
          ok: false,
          company: "Failed Co",
          baseline: false,
          dedupeAvailable: true,
          persisted: false,
          observedItems: 1,
          newItems: 1,
          summaryItems: [uncoveredItem],
          failures: ["findings were not persisted"],
          status: "completed",
          executionId: "failed-persistence",
        },
      ],
    },
    context,
  );

  assert.match(reduced.input.digest, /## Investment events/);
  assert.doesNotMatch(reduced.input.digest, /## Executive moves/);
  assert.doesNotMatch(reduced.input.digest, /## Hiring clusters/);
  assert.match(reduced.input.digest, /findings were not persisted/);
  assert.doesNotMatch(reduced.input.digest, /news\.example\/failed-co/);
  assert.equal(reduced.input.newItems, 0);
  assert.deepEqual(reduced.input.items, []);
});

test("digest surfaces signal failures from otherwise covered companies", async () => {
  const fundingItem = {
    ...item("Example Fintech A"),
    key: "example-fintech-a|funding|https://news.example/example-fintech-a-round",
    signal: "funding",
    url: "https://news.example/example-fintech-a-round",
  };
  const context = {
    shared: sharedStore({
      runDate: "2026-08-26",
      signals: ["exec_moves", "funding"],
      deliverTo: null,
    }),
    sapiom: { llm: rankingClient() },
    logger: logger(),
  };

  const reduced = await agent.steps.reduce.run(
    {
      rows: [
        {
          ok: true,
          company: "Example Fintech A",
          baseline: false,
          dedupeAvailable: true,
          persisted: true,
          observedItems: 1,
          newItems: 1,
          summaryItems: [fundingItem],
          failures: ["exec_moves search failed: timeout"],
          status: "completed",
          executionId: "partial-example-a",
        },
      ],
    },
    context,
  );

  assert.equal(reduced.input.coverage.covered, 1);
  assert.match(reduced.input.digest, /## Partial coverage/);
  assert.match(reduced.input.digest, /exec\\_moves search failed: timeout/);
  assert.match(reduced.input.digest, /example-fintech-a-round/);
});

test("ranking uses compact item indexes", async () => {
  const first = item("Example Fintech A");
  const second = item("Example Fintech B");
  let rankingSpec;
  const context = {
    shared: sharedStore({
      runDate: "2026-08-26",
      signals: ["exec_moves"],
      deliverTo: null,
    }),
    sapiom: {
      llm: rankingClient([1, 0], (spec) => {
        rankingSpec = spec;
      }),
    },
    logger: logger(),
  };

  const reduced = await agent.steps.reduce.run(
    {
      rows: [first, second].map((summaryItem) => ({
        ok: true,
        company: summaryItem.company,
        baseline: false,
        dedupeAvailable: true,
        dedupeNamespace: null,
        persisted: true,
        observedItems: 1,
        newItems: 1,
        summaryItems: [summaryItem],
        failures: [],
        status: "completed",
        executionId: `completed-${summaryItem.company}`,
      })),
    },
    context,
  );

  assert.deepEqual(
    reduced.input.items.map((row) => row.company),
    ["Example Fintech B", "Example Fintech A"],
  );
  assert.equal(rankingSpec.output.name, "rank_fintech_radar_items");
  assert.deepEqual(rankingSpec.output.schema.required, ["orderedIndexes"]);
});

test("plan previews exact costs and blocks only above the configured ceiling", async () => {
  const baseInput = {
    companies: ["Example Fintech A", "Example Fintech B", "Example Fintech C"],
    signals: ["exec_moves", "funding", "hiring"],
    window: "7d",
    maxScrapesPerCompany: 3,
    childDefinition: "fintech-exec-radar-test",
    runDate: "2026-08-26",
  };
  const context = {
    agentName: "fintech-exec-radar-test",
    shared: sharedStore(),
    logger: logger(),
  };

  const preview = await agent.steps.plan.run(
    { ...baseInput, maxCapabilityCalls: 1, dryRun: true },
    context,
  );
  assert.equal(preview.stepName, "planned");
  assert.equal(preview.input.estimate.calls.memoryWrites, 6);
  assert.equal(preview.input.estimate.calls.maximumTotal, 31);

  const omittedDryRun = await agent.steps.plan.run(
    { ...baseInput, maxCapabilityCalls: 31 },
    context,
  );
  assert.equal(
    omittedDryRun.stepName,
    "planned",
    "omitting dryRun must remain a no-spend preview without schema coercion",
  );

  const previewWithEmail = await agent.steps.plan.run(
    {
      ...baseInput,
      maxCapabilityCalls: 1,
      deliverTo: "reader@example.com",
      dryRun: true,
    },
    context,
  );
  assert.equal(previewWithEmail.input.estimate.calls.emails, 4);
  assert.equal(previewWithEmail.input.estimate.calls.maximumTotal, 35);

  const blocked = await agent.steps.plan.run(
    { ...baseInput, maxCapabilityCalls: 30, dryRun: false },
    context,
  );
  assert.equal(blocked.stepName, "budgetBlocked");
  assert.equal(blocked.input.estimate.calls.maximumTotal, 31);

  const allowed = await agent.steps.plan.run(
    { ...baseInput, maxCapabilityCalls: 31, dryRun: false },
    context,
  );
  assert.equal(allowed.stepName, "fanOut");

  const missingCompanies = await agent.steps.plan.run(
    {
      signals: ["exec_moves", "funding", "hiring"],
      window: "7d",
      maxScrapesPerCompany: 3,
      maxCapabilityCalls: 160,
      childDefinition: "fintech-exec-radar-test",
      runDate: "2026-08-26",
      dryRun: false,
    },
    context,
  );
  assert.equal(missingCompanies.kind, "fail");
  assert.match(missingCompanies.reason, /companies must contain/);
});

test("plan rejects explicit empty arrays and dedupes slug-equivalent names", async () => {
  const context = {
    agentName: "fintech-exec-radar-test",
    shared: sharedStore(),
    logger: logger(),
  };
  const baseInput = {
    signals: ["funding"],
    window: "7d",
    maxScrapesPerCompany: 0,
    maxCapabilityCalls: 20,
    dryRun: true,
  };

  const noCompanies = await agent.steps.plan.run(
    { ...baseInput, companies: [] },
    context,
  );
  assert.equal(noCompanies.kind, "fail");
  assert.match(noCompanies.reason, /companies must contain/);

  const noSignals = await agent.steps.plan.run(
    { ...baseInput, companies: ["Example Bank"], signals: [] },
    context,
  );
  assert.equal(noSignals.kind, "fail");
  assert.match(noSignals.reason, /signals must contain/);

  const deduped = await agent.steps.plan.run(
    {
      ...baseInput,
      companies: ["Example Bank", "example-bank", " Example Bank "],
    },
    context,
  );
  assert.equal(deduped.stepName, "planned");
  assert.deepEqual(deduped.input.companies, ["Example Bank"]);
  assert.equal(deduped.input.estimate.companies, 1);

  const rawOverLimitButUniqueWithinLimit = await agent.steps.plan.run(
    {
      ...baseInput,
      maxCapabilityCalls: 160,
      companies: [
        ...Array.from({ length: 15 }, (_, index) => `Company ${index}`),
        "company-0",
      ],
    },
    context,
  );
  assert.equal(rawOverLimitButUniqueWithinLimit.stepName, "planned");
  assert.equal(rawOverLimitButUniqueWithinLimit.input.companies.length, 15);

  const internationalNames = await agent.steps.plan.run(
    {
      ...baseInput,
      companies: ["例示銀行", "サンプル証券"],
    },
    context,
  );
  assert.equal(internationalNames.stepName, "planned");
  assert.deepEqual(internationalNames.input.companies, [
    "例示銀行",
    "サンプル証券",
  ]);
  assert.equal(internationalNames.input.estimate.companies, 2);

  const tooMany = await agent.steps.plan.run(
    {
      ...baseInput,
      companies: Array.from({ length: 16 }, (_, index) => `Company ${index}`),
    },
    context,
  );
  assert.equal(tooMany.kind, "fail");
  assert.match(tooMany.reason, /at most 15 unique names; received 16/);

  const excessiveScrapes = await agent.steps.plan.run(
    {
      ...baseInput,
      companies: ["Example Bank"],
      maxScrapesPerCompany: 10,
    },
    context,
  );
  assert.equal(excessiveScrapes.kind, "fail");
  assert.match(excessiveScrapes.reason, /integer from 0 to 3/);

  const invalidEmail = await agent.steps.plan.run(
    {
      ...baseInput,
      companies: ["Example Bank"],
      deliverTo: "not-an-email",
    },
    context,
  );
  assert.equal(invalidEmail.kind, "fail");
  assert.match(invalidEmail.reason, /valid email address/);
});

test("fan-out drops unsupported URLs and non-requested child signals", async () => {
  const context = {
    executionId: "parent-1",
    sapiom: {
      agents: {
        async run() {
          return {
            status: "completed",
            executionId: "child-1",
            output: {
              ok: true,
              baseline: false,
              dedupeAvailable: true,
              dedupeNamespace:
                "fintech-exec-radar-unrelated-agent-example-fintech-a-deadbeef0000",
              persisted: true,
              observedItems: 2,
              newItems: 2,
              failures: [],
              summaryItems: [
                {
                  ...item("Example Fintech A"),
                  url: "javascript:alert(document.domain)",
                },
                {
                  ...item("Example Fintech A"),
                  url: "https://www.linkedin.com/jobs/example-fintech-a",
                },
                {
                  ...item("Example Fintech A"),
                  url: "https://examplefintecha.example/news",
                },
                {
                  ...item("Example Fintech A"),
                  signal: "hiring",
                  url: "https://news.example/example-fintech-a-hiring",
                },
                item("Example Fintech A"),
              ],
            },
          };
        },
      },
    },
    logger: logger(),
  };

  const fannedOut = await agent.steps.fanOut.run(
    {
      companies: ["Example Fintech A"],
      signals: ["exec_moves"],
      window: "7d",
      maxScrapesPerCompany: 0,
      childDefinition: "fintech-exec-radar-test",
      runDate: "2026-08-26",
    },
    context,
  );

  assert.equal(fannedOut.input.rows[0].summaryItems.length, 1);
  assert.equal(fannedOut.input.rows[0].dedupeAvailable, false);
  assert.equal(fannedOut.input.rows[0].dedupeNamespace, null);
  assert.equal(
    fannedOut.input.rows[0].summaryItems[0].url,
    "https://news.example/example-fintech-a",
  );
});

test("email delivery auto-generates a sender and recovers from a create race", async () => {
  let listCalls = 0;
  let createInput;
  const operationOrder = [];
  const sourcedItem = item("Example Fintech A");
  const context = {
    shared: sharedStore({ deliverTo: "reader@example.com" }),
    sapiom: {
      memory: {
        async append(input) {
          operationOrder.push("acknowledge");
          return {
            id: "memory-1",
            content: input.content,
            createdAt: "2026-08-26T00:00:00.000Z",
          };
        },
      },
      email: {
        inboxes: {
          async list() {
            listCalls += 1;
            return {
              inboxes:
                listCalls === 1 ? [] : [{ inboxId: "race-winner-inbox" }],
            };
          },
          async create(input) {
            createInput = input;
            throw new EmailHttpError("already created", 409, {});
          },
        },
        messages: {
          async send(inboxId, input) {
            operationOrder.push("send");
            assert.equal(inboxId, "race-winner-inbox");
            assert.equal(input.to, "reader@example.com");
            return { messageId: "message-1" };
          },
        },
      },
    },
    logger: logger(),
  };

  const delivered = await agent.steps.deliver.run(
    {
      runDate: "2026-08-26",
      coverage: { requested: 1, covered: 1, failed: [] },
      newItems: 1,
      digest: "# Digest",
      items: [sourcedItem],
      children: [
        {
          company: sourcedItem.company,
          status: "completed",
          executionId: "child-1",
          ok: true,
          persisted: true,
          dedupeNamespace: "fintech-exec-radar-test-namespace",
          observedItems: 1,
          newItems: 1,
          failures: [],
        },
      ],
    },
    context,
  );

  assert.deepEqual(createInput, { displayName: "Fintech Exec Radar" });
  assert.equal(listCalls, 2);
  assert.equal(delivered.output.delivered, true);
  assert.equal(delivered.output.messageId, "message-1");
  assert.deepEqual(operationOrder, ["send", "acknowledge"]);
});

test("a failed email send leaves source keys eligible for retry", async () => {
  const memoryWrites = [];
  const sourcedItem = item("Example Fintech A");
  const context = {
    shared: sharedStore({ deliverTo: "reader@example.com" }),
    sapiom: {
      memory: {
        async append(input) {
          memoryWrites.push(input);
          return {
            id: "memory-1",
            content: input.content,
            createdAt: "2026-08-26T00:00:00.000Z",
          };
        },
      },
      email: {
        inboxes: {
          async list() {
            return { inboxes: [{ inboxId: "existing-inbox" }] };
          },
        },
        messages: {
          async send() {
            throw new Error("temporary delivery failure");
          },
        },
      },
    },
    logger: logger(),
  };

  const delivered = await agent.steps.deliver.run(
    {
      runDate: "2026-08-26",
      coverage: { requested: 1, covered: 1, failed: [] },
      newItems: 1,
      digest: "# Digest",
      items: [sourcedItem],
      children: [
        {
          company: sourcedItem.company,
          status: "completed",
          executionId: "child-1",
          ok: true,
          persisted: true,
          dedupeNamespace: "fintech-exec-radar-test-namespace",
          observedItems: 1,
          newItems: 1,
          failures: [],
        },
      ],
    },
    context,
  );

  assert.equal(delivered.output.delivered, false);
  assert.equal(delivered.output.dedupeCommitSkipped, true);
  assert.deepEqual(delivered.output.dedupeCommitFailures, []);
  assert.match(delivered.output.deliveryError, /temporary delivery failure/);
  assert.equal(memoryWrites.length, 0);
});

test("post-send acknowledgement failures stay in structured output", async () => {
  const sourcedItem = item("Example Fintech A");
  const context = {
    shared: sharedStore({ deliverTo: "reader@example.com" }),
    sapiom: {
      memory: {
        async append() {
          throw new Error("temporary memory failure");
        },
      },
      email: {
        inboxes: {
          async list() {
            return { inboxes: [{ inboxId: "existing-inbox" }] };
          },
        },
        messages: {
          async send() {
            return { messageId: "message-1" };
          },
        },
      },
    },
    logger: logger(),
  };

  const delivered = await agent.steps.deliver.run(
    {
      runDate: "2026-08-26",
      coverage: { requested: 1, covered: 1, failed: [] },
      newItems: 1,
      digest: "# Digest",
      items: [sourcedItem],
      children: [
        {
          company: sourcedItem.company,
          status: "completed",
          executionId: "child-1",
          ok: true,
          persisted: true,
          dedupeNamespace: "fintech-exec-radar-test-namespace",
          observedItems: 1,
          newItems: 1,
          failures: [],
        },
      ],
    },
    context,
  );

  assert.equal(delivered.output.delivered, true);
  assert.equal(delivered.output.digest, "# Digest");
  assert.deepEqual(delivered.output.dedupeCommitFailures, [
    "Example Fintech A",
  ]);
  assert.equal(delivered.output.dedupeCommitSkipped, false);
});

test("only a parent acknowledgement suppresses a later company run", async () => {
  const stored = [];
  const recalledNamespaces = [];
  let scrapeCalls = 0;
  const memory = {
    async recall(input) {
      recalledNamespaces.push(input.namespace);
      assert.deepEqual(input.filter, {
        recordType: "reported_source_url_keys",
      });
      const results = stored
        .filter(
          (entry) => entry.metadata?.recordType === input.filter?.recordType,
        )
        .map((entry, index) => ({
          id: `memory-${index}`,
          content: entry.content,
          score: 1,
          createdAt: "2026-08-26T00:00:00.000Z",
          occurredAt: "2026-08-26T00:00:00.000Z",
          metadata: entry.metadata,
        }));
      return {
        results,
        query: input.query,
        topK: input.topK,
        count: results.length,
      };
    },
    async append(input) {
      stored.push(input);
      return {
        id: `memory-${stored.length}`,
        content: input.content,
        createdAt: "2026-08-26T00:00:00.000Z",
      };
    },
  };
  const context = {
    agentName: "fintech-exec-radar-test",
    shared: sharedStore(),
    sapiom: {
      memory,
      search: {
        async webSearch() {
          return {
            query: "stub",
            results: [
              {
                title: "Example Fintech A executive steps down",
                url: "https://news.example/example-fintech-a-move",
                snippet: "A named executive steps down.",
              },
            ],
          };
        },
        async scrape(input) {
          scrapeCalls += 1;
          return {
            url: input.url,
            markdown: "A named Example Fintech A executive steps down.",
            metadata: {},
          };
        },
      },
    },
    logger: logger(),
  };
  const input = {
    company: "Example Fintech A",
    signals: ["exec_moves"],
    window: "7d",
    maxScrapesPerCompany: 1,
    runDate: "2026-08-26",
    invalid: false,
  };

  const first = await agent.steps.research.run(input, context);
  const unacknowledgedRetry = await agent.steps.research.run(input, context);
  await acknowledgeReportedItems(context, first.output);
  const acknowledgedRetry = await agent.steps.research.run(input, context);

  assert.equal(first.output.baseline, true);
  assert.equal(first.output.newItems, 1);
  assert.equal(unacknowledgedRetry.output.baseline, true);
  assert.equal(unacknowledgedRetry.output.newItems, 1);
  assert.equal(acknowledgedRetry.output.baseline, false);
  assert.equal(acknowledgedRetry.output.newItems, 0);
  assert.deepEqual(acknowledgedRetry.output.summaryItems, []);
  assert.equal(
    scrapeCalls,
    2,
    "the acknowledged retry must not scrape an item that dedupe will discard",
  );
  assert.equal(
    stored.length,
    4,
    "three observation snapshots and one parent acknowledgement are persisted",
  );
  assert.deepEqual(
    stored.map((entry) => entry.metadata.recordType),
    [
      "fintech_radar_observation_snapshot",
      "fintech_radar_observation_snapshot",
      "reported_source_url_keys",
      "fintech_radar_observation_snapshot",
    ],
  );
  assert.equal(new Set(recalledNamespaces).size, 1);
  assert.match(recalledNamespaces[0], /example-fintech-a-[a-f0-9]{12}$/);
});

test("an observation-history write failure keeps sourced findings deliverable", async () => {
  const stored = [];
  const context = {
    agentName: "fintech-exec-radar-best-effort-history-test",
    shared: sharedStore({ deliverTo: null }),
    sapiom: {
      memory: {
        async recall(input) {
          return {
            results: [],
            query: input.query,
            topK: input.topK,
            count: 0,
          };
        },
        async append(input) {
          if (
            input.metadata?.recordType === "fintech_radar_observation_snapshot"
          ) {
            throw new Error("temporary memory outage");
          }
          stored.push(input);
          return {
            id: `memory-${stored.length}`,
            content: input.content,
            createdAt: "2026-08-26T00:00:00.000Z",
          };
        },
      },
      search: {
        async webSearch() {
          return {
            query: "stub",
            results: [
              {
                title: "Example Fintech A raises a round",
                url: "https://industry.example/example-fintech-a-round",
                snippet: "An independent publication reports a new round.",
              },
            ],
          };
        },
        async scrape() {
          throw new Error("scrape should be disabled");
        },
      },
    },
    logger: logger(),
  };

  const researched = await agent.steps.research.run(
    {
      company: "Example Fintech A",
      signals: ["funding"],
      window: "7d",
      maxScrapesPerCompany: 0,
      runDate: "2026-08-26",
      invalid: false,
    },
    context,
  );

  assert.equal(researched.output.ok, true);
  assert.equal(researched.output.persisted, false);
  assert.equal(researched.output.summaryItems.length, 1);
  assert.match(researched.output.failures[0], /findings were not persisted/);

  const delivered = await acknowledgeReportedItems(context, researched.output);
  assert.deepEqual(delivered.output.dedupeCommitFailures, []);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].metadata.recordType, "reported_source_url_keys");
});

test("long company names with the same prefix use distinct memory namespaces", async () => {
  const recalledNamespaces = [];
  const context = {
    agentName: "fintech-exec-radar-test",
    shared: sharedStore(),
    sapiom: {
      memory: {
        async recall(input) {
          recalledNamespaces.push(input.namespace);
          return {
            results: [],
            query: input.query,
            topK: input.topK,
            count: 0,
          };
        },
        async append(input) {
          return {
            id: "memory-1",
            content: input.content,
            createdAt: "2026-08-26T00:00:00.000Z",
          };
        },
      },
      search: {
        async webSearch() {
          return { query: "stub", results: [] };
        },
        async scrape() {
          throw new Error("no results should be scraped");
        },
      },
    },
    logger: logger(),
  };
  const baseInput = {
    signals: ["funding"],
    window: "7d",
    maxScrapesPerCompany: 0,
    runDate: "2026-08-26",
    invalid: false,
  };

  await agent.steps.research.run(
    {
      ...baseInput,
      company: "Example Financial Technology Holdings North America",
    },
    context,
  );
  await agent.steps.research.run(
    {
      ...baseInput,
      company: "Example Financial Technology Holdings Europe",
    },
    context,
  );

  assert.equal(recalledNamespaces.length, 2);
  assert.notEqual(recalledNamespaces[0], recalledNamespaces[1]);
  assert.ok(recalledNamespaces.every((namespace) => namespace.length <= 100));
});

test("the parent acknowledges only findings returned across the fan-in boundary", async () => {
  const stored = [];
  let searchCall = 0;
  const context = {
    agentName: "fintech-exec-radar-overflow-test",
    shared: sharedStore(),
    sapiom: {
      memory: {
        async recall(input) {
          const results = stored
            .filter(
              (entry) =>
                entry.metadata?.recordType === input.filter?.recordType,
            )
            .map((entry, index) => ({
              id: `memory-${index}`,
              content: entry.content,
              score: 1,
              createdAt: "2026-08-26T00:00:00.000Z",
              occurredAt: "2026-08-26T00:00:00.000Z",
              metadata: entry.metadata,
            }));
          return {
            results,
            query: input.query,
            topK: input.topK,
            count: results.length,
          };
        },
        async append(input) {
          stored.push(input);
          return {
            id: `memory-${stored.length}`,
            content: input.content,
            createdAt: "2026-08-26T00:00:00.000Z",
          };
        },
      },
      search: {
        async webSearch() {
          const batch = searchCall++ % 3;
          return {
            query: "stub",
            results: Array.from({ length: 4 }, (_, index) => ({
              title: `Independent finding ${batch}-${index}`,
              url: `https://industry.example/finding-${batch}-${index}`,
              snippet: "Independent sourced report.",
            })),
          };
        },
        async scrape() {
          throw new Error("scrape should be disabled");
        },
      },
    },
    logger: logger(),
  };
  const input = {
    company: "Example Fintech A",
    signals: ["exec_moves", "funding", "hiring"],
    window: "7d",
    maxScrapesPerCompany: 0,
    runDate: "2026-08-26",
    invalid: false,
  };

  const first = await agent.steps.research.run(input, context);
  const firstSnapshot = JSON.parse(stored[0].content);
  assert.equal(first.output.newItems, 12);
  assert.equal(first.output.summaryItems.length, 5);
  assert.deepEqual(
    new Set(first.output.summaryItems.map((row) => row.signal)),
    new Set(["exec_moves", "funding", "hiring"]),
  );
  assert.equal(firstSnapshot.items.length, 12);
  assert.equal(firstSnapshot.itemKeys, undefined);

  await acknowledgeReportedItems(context, first.output);
  const firstAcknowledgement = JSON.parse(stored[1].content);
  assert.deepEqual(
    firstAcknowledgement.itemKeys,
    first.output.summaryItems.map((row) => row.key),
  );

  const second = await agent.steps.research.run(input, context);
  assert.equal(second.output.newItems, 7);
  assert.equal(second.output.summaryItems.length, 5);
  assert.equal(
    second.output.summaryItems.some((row) =>
      firstAcknowledgement.itemKeys.includes(row.key),
    ),
    false,
  );
});

test("research never scrapes custom-company or LinkedIn URLs", async () => {
  const scraped = [];
  const context = {
    agentName: "fintech-exec-radar-domain-test",
    shared: sharedStore(),
    sapiom: {
      memory: {
        async recall(input) {
          return {
            results: [],
            query: input.query,
            topK: input.topK,
            count: 0,
          };
        },
        async append(input) {
          return {
            id: "memory-1",
            content: input.content,
            createdAt: "2026-08-26T00:00:00.000Z",
          };
        },
      },
      search: {
        async webSearch() {
          return {
            query: "stub",
            results: [
              {
                title: "Example Payments Company careers",
                url: "https://careers.examplepayments.example/openings",
                snippet: "Example Payments Company is hiring.",
              },
              {
                title: "Example Payments Company newsroom",
                url: "https://newsroom.examplepayments.example/hiring",
                snippet: "Example Payments Company announces hiring.",
              },
              {
                title: "Trade press covers Example Payments Company hiring",
                url: "https://industry.example/example-payments-hiring",
                snippet:
                  "A trade publication reports Example Payments Company hiring.",
              },
              {
                title: "Independent analysis of Example Payments Company",
                url: "https://example.example/example-payments-analysis",
                snippet:
                  "An independent publication analyzes Example Payments Company.",
              },
              {
                title: "Example Payments Company jobs on LinkedIn",
                url: "https://www.linkedin.com/jobs/example-payments-jobs",
                snippet:
                  "A job-board search result lists Example Payments Company roles.",
              },
            ],
          };
        },
        async scrape(input) {
          scraped.push(input.url);
          return {
            url: input.url,
            markdown: "Independent article.",
            metadata: {},
          };
        },
      },
    },
    logger: logger(),
  };

  const result = await agent.steps.research.run(
    {
      company: "Example Payments Company",
      signals: ["hiring"],
      window: "7d",
      maxScrapesPerCompany: 3,
      runDate: "2026-08-26",
      invalid: false,
    },
    context,
  );

  assert.deepEqual(scraped, [
    "https://industry.example/example-payments-hiring",
    "https://example.example/example-payments-analysis",
  ]);
  assert.equal(result.output.observedItems, 2);
  assert.equal(result.output.summaryItems.length, 2);
  assert.equal(
    result.output.summaryItems[0].url,
    "https://industry.example/example-payments-hiring",
  );
});

test("research spreads article reads across requested signals", async () => {
  const scraped = [];
  const context = {
    agentName: "fintech-exec-radar-balanced-scrape-test",
    shared: sharedStore(),
    sapiom: {
      memory: {
        async recall(input) {
          return {
            results: [],
            query: input.query,
            topK: input.topK,
            count: 0,
          };
        },
        async append(input) {
          return {
            id: "memory-1",
            content: input.content,
            createdAt: "2026-08-26T00:00:00.000Z",
          };
        },
      },
      search: {
        async webSearch(input) {
          const signal = input.query.includes("appoints")
            ? "exec"
            : input.query.includes("raises")
              ? "funding"
              : "hiring";
          return {
            query: input.query,
            results: [
              {
                title: `Independent ${signal} finding`,
                url: `https://industry.example/${signal}`,
                snippet: "Independent sourced report.",
              },
            ],
          };
        },
        async scrape(input) {
          scraped.push(input.url);
          return {
            url: input.url,
            markdown: "Independent article.",
            metadata: {},
          };
        },
      },
    },
    logger: logger(),
  };

  await agent.steps.research.run(
    {
      company: "Example Fintech A",
      signals: ["exec_moves", "funding", "hiring"],
      window: "7d",
      maxScrapesPerCompany: 3,
      runDate: "2026-08-26",
      invalid: false,
    },
    context,
  );

  assert.deepEqual(scraped, [
    "https://industry.example/exec",
    "https://industry.example/funding",
    "https://industry.example/hiring",
  ]);
});
