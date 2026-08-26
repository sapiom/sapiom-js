import assert from "node:assert/strict";
import test from "node:test";

import { agent, readReport } from "./index.ts";
import {
  CRITIQUE_SCHEMA,
  buildCritiquePrompt,
  readJudgment,
} from "./critique.js";

// `publish` re-attaches the coding run's environment and deploys it.
// `deployPreview` only serves from a compatible cloud sandbox; a coding run in local
// host mode leaves its files on the runner host, and attaching that id + deploying
// 404s with "Sandbox not found" (SAP-2203). `publish` must detect the
// non-deployable environment up front and degrade honestly instead of attempting
// a deploy that cannot succeed.

/** A completed coding result whose run used `type`. */
function codingResult(type, id = "research-to-microsite-abc123") {
  return {
    runId: "run-1",
    status: "completed",
    summary: "built the site",
    result: {
      success: true,
      turns: 3,
      modelUsed: "x",
      durationMs: 1,
      toolCallCount: 1,
      usage: {},
    },
    error: null,
    executionEnvironment: { type, id },
  };
}

/** Generic ctx double for the fused research/critique/illustration steps: a
 * Map-backed shared store plus whatever `sapiom` stubs a test needs. */
function stepContext({ seed = {}, sapiom = {} } = {}) {
  const shared = new Map(Object.entries(seed));
  return {
    executionId: "exec-1",
    shared: {
      get: (key) => shared.get(key),
      set: (key, value) => shared.set(key, value),
    },
    sapiom,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

function llmDouble(run) {
  return {
    run,
    structuredOf(response, name) {
      return response.content.find(
        (block) =>
          block.type === "tool_use" &&
          (name === undefined || block.name === name),
      )?.input;
    },
  };
}

/**
 * A forced-tool-call reply, the shape `llm.run`'s `output` produces. SAP-2892
 * moved both of this template's model calls onto it — there is no prose reply to
 * fake any more.
 */
function llmToolUse(name, input) {
  return { content: [{ type: "tool_use", name, input }] };
}

/**
 * Minimal ctx double for `publish`. Records sandbox attaches so we can assert
 * none happen on a non-deployable environment; stubs `repositories.get`
 * (pushed the coding sandbox's build) and `sandboxes.create` (the durable
 * host `deployPreview` is called against) for the real deploy path.
 */
function publishContext({ attachCalls = [], deployResult, seed = {} } = {}) {
  const shared = new Map(Object.entries(seed));
  return {
    executionId: "exec-1",
    shared: {
      get: (key) => shared.get(key),
      set: (key, value) => shared.set(key, value),
    },
    sapiom: {
      sandboxes: {
        attach(name) {
          attachCalls.push(name);
          return {};
        },
        async create() {
          return {
            async deployPreview() {
              return deployResult;
            },
          };
        },
      },
      repositories: {
        async get() {
          return { async pushFromSandbox() {} };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test("publish degrades honestly when the coding run used a local-host environment (SAP-2203)", async () => {
  const attachCalls = [];
  const directive = await agent.steps.publish.run(
    codingResult("local_host", "/tmp/sapiom-coding-runs/runs/abc"),
    publishContext({ attachCalls }),
  );

  // Route to the honest-degrade terminal, carrying the environment type — never
  // to `failed`, and never attempting the deploy that would 404.
  assert.equal(directive.stepName, "builtNotPublished");
  assert.equal(directive.input.environmentType, "local_host");
  assert.deepEqual(
    attachCalls,
    [],
    "must not attach/deploy a non-deployable environment",
  );
});

test("publish deploys and goes live when the coding run used a compatible cloud sandbox", async () => {
  const attachCalls = [];
  const directive = await agent.steps.publish.run(
    codingResult("blaxel_sandbox", "research-to-microsite-abc123"),
    publishContext({
      attachCalls,
      seed: { repoSlug: "microsite-abc123" },
      deployResult: {
        url: "https://research-to-microsite-abc123.preview.sapiom.ai",
        status: "deployed",
        logs: "",
      },
    }),
  );

  // The production path is unchanged: attach the sandbox, deploy, go live.
  assert.equal(directive.stepName, "live");
  assert.equal(
    directive.input.liveUrl,
    "https://research-to-microsite-abc123.preview.sapiom.ai",
  );
  assert.deepEqual(attachCalls, ["research-to-microsite-abc123"]);
});

test("builtNotPublished is a meaningful terminal that names the local-mode limitation", async () => {
  const directive = await agent.steps.builtNotPublished.run(
    { environmentType: "local_host" },
    publishContext({
      seed: {
        topic: "durable agent runtimes",
        reportTitle: "Durable Agent Runtimes",
        reportTagline: "Retries, done right.",
        sources: [{ title: "s", url: "https://example.com" }],
        sandboxName: "/tmp/sapiom-coding-runs/runs/abc",
      },
    }),
  );

  assert.equal(directive.kind, "terminate");
  const out = directive.output;
  assert.equal(out.published, false);
  assert.equal(out.built, true);
  assert.equal(out.reason, "non-deployable-environment");
  assert.equal(out.environmentType, "local_host");
  assert.equal(out.title, "Durable Agent Runtimes");
  // The note explains this publishes for real on the deployed stack — an
  // honest degrade, not a 404.
  assert.match(out.note, /deployed Sapiom stack/i);
});

// `gather` absorbs `web-research-digest`'s search step and adds multi-query
// dedupe: complementary queries routinely resurface the same page, and
// `gather` must not pay to scrape it twice.

test("gather dedupes candidates across queries by normalized URL before scraping", async () => {
  const scrapeCalls = [];
  const ctx = stepContext({
    sapiom: {
      search: {
        webSearch: async ({ query }) => ({
          query,
          results: [
            {
              title: "Same page",
              url: "https://Example.com/a/",
              snippet: "s1",
            },
            {
              title: "Same page (www)",
              url: "https://www.example.com/a",
              snippet: "s2",
            },
          ],
        }),
        scrape: async ({ url }) => {
          scrapeCalls.push(url);
          return { markdown: "full text", metadata: { title: "Same page" } };
        },
      },
    },
  });
  const directive = await agent.steps.gather.run(
    { queries: ["topic", "topic recent developments"] },
    ctx,
  );
  assert.equal(directive.stepName, "synthesize");
  // Two queries each return the same page (bare vs "www." + trailing slash) —
  // deduped to one scrape, not four.
  assert.equal(scrapeCalls.length, 1);
  assert.equal(directive.input.sources.length, 1);
});

// `synthesize` stops before spending a model call when there's nothing to
// write from, and reuses the bounded research excerpts already gathered on a
// revise loop-back from `critique` (no `sources` in that payload).

test("synthesize stops at drafted, without calling the model, when gather found nothing", async () => {
  let modelCalled = false;
  const ctx = stepContext({
    seed: { topic: "empty topic", audience: "a general audience" },
    sapiom: {
      llm: llmDouble(async () => {
        modelCalled = true;
        return llmToolUse("emit_report", {});
      }),
    },
  });
  const directive = await agent.steps.synthesize.run({ sources: [] }, ctx);
  assert.equal(directive.stepName, "drafted");
  assert.equal(directive.input.reason, "empty-report");
  assert.equal(modelCalled, false);
});

test("synthesize reuses previously gathered sources and carries the critique forward on a revise loop-back", async () => {
  const ctx = stepContext({
    seed: {
      topic: "durable retries",
      audience: "developers",
      researchSources: [
        { title: "S", url: "https://example.com/s", snippet: "snip" },
      ],
      previousReport: {
        title: "Old",
        tagline: "",
        summary: "",
        sections: [],
        sources: [],
      },
      critique: "too thin",
    },
    sapiom: {
      llm: llmDouble(async ({ request }) => {
        const prompt = request.messages[0].content;
        assert.match(prompt, /CRITIQUE/);
        assert.match(prompt, /too thin/);
        return llmToolUse("emit_report", {
          title: "New",
          tagline: "t",
          summary: "s",
          sections: [{ heading: "H", body: "b [1]" }],
        });
      }),
    },
  });
  // No `sources` in the payload — the revise loop-back from `critique`.
  const directive = await agent.steps.synthesize.run({}, ctx);
  assert.equal(directive.stepName, "critique");
  assert.equal(directive.input.report.title, "New");
});

// `critique` folds in the eval-gate self-critique idiom: judge, then branch —
// revise (bounded), or move on (to `illustrate`, or `drafted` under dryRun).

const SAMPLE_REPORT = {
  title: "T",
  tagline: "",
  summary: "s",
  sections: [{ heading: "H", body: "b [1]" }],
  sources: [{ title: "s", url: "https://example.com" }],
};

test("critique revises when the score is below threshold and attempts remain", async () => {
  const ctx = stepContext({
    seed: {
      audience: "developers",
      iteration: 1,
      maxDraftAttempts: 2,
      reviewThreshold: 0.9,
      dryRun: false,
    },
    sapiom: {
      llm: llmDouble(async () =>
        llmToolUse("emit_judgment", { score: 0.5, rationale: "too thin" }),
      ),
    },
  });
  const directive = await agent.steps.critique.run(
    { report: SAMPLE_REPORT },
    ctx,
  );
  assert.equal(directive.stepName, "synthesize");
  assert.equal(ctx.shared.get("iteration"), 2);
  assert.equal(ctx.shared.get("previousReport"), SAMPLE_REPORT);
  assert.equal(ctx.shared.get("critique"), "too thin");
});

test("critique proceeds to illustrate once the score clears the threshold", async () => {
  const ctx = stepContext({
    seed: {
      audience: "developers",
      iteration: 1,
      maxDraftAttempts: 2,
      reviewThreshold: 0.7,
      dryRun: false,
    },
    sapiom: {
      llm: llmDouble(async () =>
        llmToolUse("emit_judgment", { score: 0.9, rationale: "solid" }),
      ),
    },
  });
  const directive = await agent.steps.critique.run(
    { report: SAMPLE_REPORT },
    ctx,
  );
  assert.equal(directive.stepName, "illustrate");
  assert.equal(directive.input.reviewPassed, true);
  assert.equal(directive.input.reviewScore, 0.9);
});

test("critique stops revising once maxDraftAttempts is exhausted, even below threshold", async () => {
  const ctx = stepContext({
    seed: {
      audience: "developers",
      iteration: 2,
      maxDraftAttempts: 2,
      reviewThreshold: 0.9,
      dryRun: false,
    },
    sapiom: {
      llm: llmDouble(async () =>
        llmToolUse("emit_judgment", { score: 0.4, rationale: "still thin" }),
      ),
    },
  });
  const directive = await agent.steps.critique.run(
    { report: SAMPLE_REPORT },
    ctx,
  );
  assert.equal(directive.stepName, "illustrate");
  assert.equal(directive.input.reviewPassed, false);
  assert.equal(directive.input.reviewIterations, 2);
});

test("critique routes to drafted, not illustrate, when dryRun is set", async () => {
  const ctx = stepContext({
    seed: {
      audience: "developers",
      iteration: 1,
      maxDraftAttempts: 2,
      reviewThreshold: 0.5,
      dryRun: true,
    },
    sapiom: {
      llm: llmDouble(async () =>
        llmToolUse("emit_judgment", { score: 0.9, rationale: "fine" }),
      ),
    },
  });
  const directive = await agent.steps.critique.run(
    { report: SAMPLE_REPORT },
    ctx,
  );
  assert.equal(directive.stepName, "drafted");
  assert.equal(directive.input.reason, "dry-run");
  assert.equal(directive.input.reviewPassed, true);
});

// `illustrate` ⇄ `collectIllustration` mirror scene-to-video's keyframe fan-out,
// with illustration folded to zero-cost when unwanted and best-effort when it fails.

const TWO_SECTION_REPORT = {
  title: "T",
  tagline: "",
  summary: "s",
  sections: [
    { heading: "H1", body: "b1" },
    { heading: "H2", body: "b2" },
  ],
  sources: [],
};

test("illustrate skips straight to build when illustrationCount is 0", async () => {
  const ctx = stepContext({
    seed: { illustrationCount: 0, illustrationIndex: 0 },
  });
  const directive = await agent.steps.illustrate.run(
    {
      report: TWO_SECTION_REPORT,
      reviewScore: 0.9,
      reviewPassed: true,
      reviewIterations: 1,
    },
    ctx,
  );
  assert.equal(directive.stepName, "build");
  assert.equal(ctx.shared.get("report"), TWO_SECTION_REPORT);
});

test("illustrate degrades honestly (to collectIllustration with no output) when the image launch throws", async () => {
  const ctx = stepContext({
    seed: { illustrationCount: 2, illustrationIndex: 0 },
    sapiom: {
      contentGeneration: {
        images: {
          launch: async () => {
            throw new Error("quota exceeded");
          },
        },
      },
    },
  });
  const directive = await agent.steps.illustrate.run(
    { report: TWO_SECTION_REPORT },
    ctx,
  );
  assert.equal(directive.stepName, "collectIllustration");
  assert.deepEqual(directive.input, { outputs: [] });
});

test("collectIllustration continues without an image when the result carries no usable output", async () => {
  const ctx = stepContext({
    seed: {
      report: TWO_SECTION_REPORT,
      illustrations: [],
      illustrationCount: 2,
      illustrationIndex: 0,
    },
  });
  const directive = await agent.steps.collectIllustration.run(
    { outputs: [] },
    ctx,
  );
  assert.equal(directive.stepName, "illustrate");
  assert.deepEqual(ctx.shared.get("illustrations"), []);
  assert.equal(ctx.shared.get("illustrationIndex"), 1);
});

test("collectIllustration records a usable image and loops for the next section", async () => {
  const ctx = stepContext({
    seed: {
      report: TWO_SECTION_REPORT,
      illustrations: [],
      illustrationCount: 2,
      illustrationIndex: 0,
    },
  });
  const directive = await agent.steps.collectIllustration.run(
    { outputs: [{ fileId: "f1", downloadUrl: "https://x/f1" }] },
    ctx,
  );
  assert.equal(directive.stepName, "illustrate");
  assert.deepEqual(ctx.shared.get("illustrations"), [
    { heading: "H1", fileId: "f1", downloadUrl: "https://x/f1" },
  ]);
});

test("collectIllustration advances to build once the illustration budget is spent", async () => {
  const ctx = stepContext({
    seed: {
      report: TWO_SECTION_REPORT,
      illustrations: [],
      illustrationCount: 1,
      illustrationIndex: 0,
    },
  });
  const directive = await agent.steps.collectIllustration.run(
    { outputs: [{ downloadUrl: "https://x/f1" }] },
    ctx,
  );
  assert.equal(directive.stepName, "build");
});

// ── SAP-2892: an unusable reply must never become the published site ────────

const SOURCES = [{ title: "A study", url: "https://a.test/1" }];
const REPORT = {
  title: "Coordination cost",
  tagline: "Why small teams outship big ones",
  summary: "Three studies converge. [1]",
  sections: [
    { heading: "The evidence", body: "The study found [1] ..." },
    { heading: "The mechanism", body: "Every extra person [1] ..." },
    { heading: "What to do", body: "Keep teams small [1] ..." },
  ],
};

test("readReport reads the forced tool call's report", () => {
  const report = readReport(REPORT, SOURCES);
  assert.equal(report.title, "Coordination cost");
  assert.equal(report.sections.length, 3);
});

test("readReport takes sources from the scrape set, never from the model", () => {
  const report = readReport(
    { ...REPORT, sources: [{ title: "Invented", url: "https://nope.test" }] },
    SOURCES,
  );
  assert.deepEqual(report.sources, SOURCES);
});

test("readReport throws when the response carried no structured report", () => {
  assert.throws(() => readReport(undefined, SOURCES), /no structured report/);
  assert.throws(() => readReport(null, SOURCES), /no structured report/);
  assert.throws(
    () => readReport("```json\n{ not really json\n```", SOURCES),
    /no structured report/,
  );
});

test("readReport throws rather than publishing an empty site", () => {
  // The old fallback was `{ title: topic, sections: [] }`, carried on through
  // `critique`, `illustrate` and `build` to a real, empty, public URL.
  assert.throws(
    () => readReport({ ...REPORT, sections: [] }, SOURCES),
    /no report sections/,
  );
  assert.throws(
    () =>
      readReport({ ...REPORT, sections: [{ heading: "", body: "" }] }, SOURCES),
    /no report sections/,
  );
  assert.throws(
    () => readReport({ ...REPORT, title: " " }, SOURCES),
    /no report title/,
  );
});

// ── The judge's grade, same rule ────────────────────────────────────────────

test("readJudgment reads the grade and clamps a 0-100 answer", () => {
  assert.deepEqual(readJudgment({ score: 0.9, rationale: "Well cited." }), {
    score: 0.9,
    rationale: "Well cited.",
  });
  assert.equal(readJudgment({ score: 90, rationale: "" }).score, 0.9);
});

test("readJudgment throws rather than grading on a number found in prose", () => {
  assert.throws(() => readJudgment(undefined), /no structured grade/);
  assert.throws(() => readJudgment(null), /no structured grade/);
  assert.throws(
    () => readJudgment("Section 3 cites only 1 source, so I'd say it's close."),
    /no structured grade/,
  );
  assert.throws(() => readJudgment({ rationale: "Close." }), /no usable score/);
});

test("neither prompt dictates a reply format any more — the schemas do", () => {
  const critiquePrompt = buildCritiquePrompt({
    report: { ...REPORT, sources: SOURCES },
    audience: "engineering leaders",
  });
  assert.doesNotMatch(critiquePrompt, /ONLY a JSON object/i);
  assert.match(critiquePrompt, /engineering leaders/);
  assert.deepEqual(CRITIQUE_SCHEMA.required, ["score", "rationale"]);
});
