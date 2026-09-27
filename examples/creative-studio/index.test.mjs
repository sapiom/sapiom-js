import assert from "node:assert/strict";
import test from "node:test";

import { AGENTS_RESULT_SIGNAL, fileStorage } from "@sapiom/tools";

import {
  agent,
  buildClipPrompt,
  buildPlanSchema,
  buildPlatePrompt,
  clampDuration,
  clampShots,
  maxWordsFor,
  normalizeRatio,
  passesCheck,
  pickBestAttempt,
  planWarnings,
  plateUsable,
  readPlan,
  readVerdict,
  runStructured,
} from "./index.ts";

const shot = (over = {}) => ({
  edit_instruction: "Place the person on the stairs.",
  motion_prompt: "The keeper climbs. Slow tilt up.",
  speaker: "",
  line: "",
  duration: 6,
  ...over,
});

function ctx(initial = {}, sapiom = {}) {
  const shared = new Map(Object.entries(initial));
  return {
    shared,
    ctx: {
      executionId: "exec-1",
      agentName: "creative-studio",
      shared: {
        get: (k) => shared.get(k),
        set: (k, v) => shared.set(k, v),
      },
      sapiom,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
}

// ─── pure helpers ───────────────────────────────────────────────────────────

test("clamps shot counts, durations and aspect ratios to what the models accept", () => {
  assert.equal(clampShots(undefined), 4);
  assert.equal(clampShots(0), 1);
  assert.equal(clampShots(9), 6);
  assert.equal(clampDuration(2), 4);
  assert.equal(clampDuration(8.4), 8);
  assert.equal(clampDuration(40), 15);
  assert.equal(clampDuration("x"), 5);
  assert.equal(normalizeRatio("9:16"), "9:16");
  assert.equal(normalizeRatio("4:3"), "16:9");
});

test("the clip prompt quotes the planned line verbatim after the motion prompt", () => {
  const p = buildClipPrompt(
    shot({ speaker: "the keeper", line: "Not tonight. Not on my watch." }),
  );
  assert.match(
    p,
    /^The keeper climbs\. Slow tilt up\. The keeper says, clearly and at a natural pace: "Not tonight\. Not on my watch\."$/,
  );
  assert.equal(buildClipPrompt(shot()), "The keeper climbs. Slow tilt up.");
});

test("the plate prompt asks for one figure with no text or panels", () => {
  const p = buildPlatePrompt({
    character: "an old keeper in a yellow coat",
    bible: "35mm, teal and amber",
  });
  assert.match(
    p,
    /^One photograph of one person standing alone: an old keeper in a yellow coat\. The whole body/,
  );
  assert.match(
    p,
    /Not a character sheet or turnaround: no multiple views, no panels, no text/,
  );
});

test("warns when a line is longer than its clip can hold at 2.5 words per second", () => {
  assert.equal(maxWordsFor(6), 15);
  const plan = {
    character: "c",
    bible: "b",
    shots: [
      shot({ line: "one two three four five", duration: 4 }),
      shot({
        line: Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "),
        duration: 4,
      }),
    ],
  };
  const w = planWarnings(plan);
  assert.equal(w.length, 1);
  assert.match(w[0], /^Shot 2: the line has 20 words for a 4s clip/);
});

test("readPlan reads the plan, clamps durations and strips quotes from lines", () => {
  const p = readPlan(
    {
      character: " keeper ",
      bible: "look",
      shots: [shot({ line: '"Hello there."', duration: 30 }), shot(), shot()],
    },
    2,
  );
  assert.equal(p.character, "keeper");
  assert.equal(p.shots.length, 2);
  assert.equal(p.shots[0].line, "Hello there.");
  assert.equal(p.shots[0].duration, 15);
});

test("readPlan refuses to invent a character, a bible or a shot's prompts", () => {
  assert.throws(() => readPlan(undefined, 4), /no structured plan/);
  assert.throws(
    () => readPlan({ bible: "b", shots: [shot()] }, 4),
    /no character/,
  );
  assert.throws(
    () => readPlan({ character: "c", shots: [shot()] }, 4),
    /no style bible/,
  );
  assert.throws(
    () => readPlan({ character: "c", bible: "b", shots: [] }, 4),
    /no shots/,
  );
  assert.throws(
    () =>
      readPlan(
        { character: "c", bible: "b", shots: [shot({ motion_prompt: " " })] },
        4,
      ),
    /no motion prompt for shot 1/,
  );
});

test("buildPlanSchema asks for exactly the requested number of shots", () => {
  const s = buildPlanSchema(4);
  assert.equal(s.properties.shots.minItems, 4);
  assert.equal(s.properties.shots.maxItems, 4);
  assert.equal(s.properties.shots.items.properties.duration.minimum, 4);
  assert.equal(s.properties.shots.items.properties.duration.maximum, 15);
});

test("a keyframe passes only as the same person in the same clothes at 7/10 or more", () => {
  const v = {
    same_person: true,
    clothing_matches: true,
    palette_matches: true,
    composition_matches: true,
    score: 7,
    issues: "",
  };
  assert.equal(passesCheck(v), true);
  assert.equal(passesCheck({ ...v, score: 6 }), false);
  assert.equal(passesCheck({ ...v, same_person: false }), false);
  assert.equal(passesCheck({ ...v, clothing_matches: false }), false);
  assert.equal(passesCheck({ ...v, composition_matches: false }), false);
  assert.throws(() => readVerdict({}), /no verdict/);
});

test("a plate is usable only as one figure with no text or panels", () => {
  assert.equal(plateUsable({ people: 1, has_text_or_panels: false }), true);
  assert.equal(plateUsable({ people: 3, has_text_or_panels: false }), false);
  assert.equal(plateUsable({ people: 1, has_text_or_panels: true }), false);
});

// ─── steps ──────────────────────────────────────────────────────────────────

test("a per-shot child run skips planning and goes straight to its keyframe", async () => {
  const job = {
    index: 2,
    shot: shot(),
    plateFileId: "plate",
    character: "c",
    bible: "b",
  };
  const { ctx: c, shared } = ctx();
  const d = await agent.steps.plan.run({ shot: job }, c);
  assert.equal(d.kind, "continue");
  assert.equal(d.stepName, "keyframe");
  assert.deepEqual(shared.get("job"), job);
});

test("shots launches one child per shot with a retry-safe key, then pauses on the first", async () => {
  const launched = [];
  const plan = {
    character: "c",
    bible: "b",
    shots: [shot(), shot({ line: "hi", speaker: "the keeper" })],
  };
  const { ctx: c, shared } = ctx(
    { plan, plateFileId: "plate-1" },
    {
      agents: {
        launch: async (spec) => {
          launched.push(spec);
          const id = `child-${launched.length}`;
          return {
            executionId: id,
            dispatch: { correlationId: id, resultSignal: AGENTS_RESULT_SIGNAL },
          };
        },
      },
    },
  );
  const d = await agent.steps.shots.run({}, c);
  assert.deepEqual(
    launched.map((l) => l.idempotencyKey),
    ["exec-1:shot:0", "exec-1:shot:1"],
  );
  assert.equal(launched[0].definition, "creative-studio");
  assert.equal(launched[1].input.shot.shot.line, "hi");
  assert.deepEqual(shared.get("childIds"), ["child-1", "child-2"]);
  assert.equal(d.signal.name, AGENTS_RESULT_SIGNAL);
  assert.equal(d.signal.correlationId, "child-1");
  assert.equal(d.resumeStep, "gather");
});

const shotResult = (index, over = {}) => ({
  index,
  clipFileId: `clip-${index}`,
  clipUrl: "",
  keyframeFileId: "",
  keyframeUrl: "",
  keyframeAttempts: 1,
  check: null,
  checks: [],
  duration: 5,
  line: "",
  audio: false,
  clipSeconds: 5,
  costUsd: 1.5,
  warnings: [],
  ...over,
});

test("gather records a child and pauses on the next child by its execution id", async () => {
  const { ctx: c, shared } = ctx({
    childIds: ["a", "b"],
    gatherIndex: 0,
    results: [],
    warnings: [],
    costUsd: 0.15,
  });
  const d = await agent.steps.gather.run(
    { status: "completed", output: shotResult(0, { warnings: ["w0"] }) },
    c,
  );
  assert.equal(d.kind, "pause_until_signal");
  assert.equal(d.signal.correlationId, "b");
  assert.equal(shared.get("gatherIndex"), 1);
  assert.deepEqual(shared.get("warnings"), ["w0"]);
  assert.equal(shared.get("costUsd"), 1.65);
});

test("gather keeps going when a child fails and stitches the rest", async () => {
  const { ctx: c, shared } = ctx({
    childIds: ["a", "b"],
    gatherIndex: 1,
    results: [shotResult(0)],
    warnings: [],
    costUsd: 0,
  });
  const d = await agent.steps.gather.run(
    { status: "failed", error: { message: "boom" } },
    c,
  );
  assert.equal(d.kind, "continue");
  assert.equal(d.stepName, "stitch");
  assert.equal(shared.get("results")[1], null);
  assert.match(shared.get("warnings")[0], /^Shot 2 failed and was left out/);
});

test("check redoes a drifting keyframe once, then accepts it with a warning", async () => {
  const drift = {
    same_person: false,
    clothing_matches: true,
    palette_matches: true,
    composition_matches: true,
    score: 3,
    issues: "different face",
  };
  const llm = {
    run: async () => ({}),
    structuredOf: () => drift,
  };
  const job = {
    index: 0,
    shot: shot(),
    plateFileId: "plate",
    character: "c",
    bible: "b",
  };

  const first = ctx(
    { job, keyframeAttempt: 1, keyframeFileId: "kf1", childWarnings: [] },
    { llm },
  );
  const d1 = await agent.steps.check.run({}, first.ctx);
  assert.equal(d1.stepName, "keyframe");

  const second = ctx(
    { job, keyframeAttempt: 2, keyframeFileId: "kf2", childWarnings: [] },
    { llm },
  );
  const d2 = await agent.steps.check.run({}, second.ctx);
  assert.equal(d2.stepName, "animate");
  assert.match(
    second.shared.get("childWarnings")[0],
    /no keyframe passed the check after a redo; used attempt 1 of 1 \(score 3\/10: different face\)/,
  );
});

test("check sends the plate and the keyframe to the vision model as images", async () => {
  let request;
  const llm = {
    run: async (r) => ((request = r), {}),
    structuredOf: () => ({
      same_person: true,
      clothing_matches: true,
      palette_matches: true,
      composition_matches: true,
      score: 9,
      issues: "",
    }),
  };
  const job = {
    index: 0,
    shot: shot(),
    plateFileId: "plate",
    character: "c",
    bible: "b",
  };
  const { ctx: c } = ctx(
    { job, keyframeAttempt: 1, keyframeFileId: "kf1", childWarnings: [] },
    { llm },
  );
  const d = await agent.steps.check.run({}, c);
  assert.equal(d.stepName, "animate");
  const images = request.request.messages[0].content
    .filter((b) => b.type === "image")
    .map((b) => b.source.url);
  assert.deepEqual(images, [
    fileStorage.getPublicUrl("plate"),
    fileStorage.getPublicUrl("kf1"),
  ]);
});

test("animate sends seedance-i2v the keyframe, the duration and audio only for a spoken shot", async () => {
  const calls = [];
  const video = {
    launch: async (spec) => {
      calls.push(spec);
      return {
        requestId: "r",
        dispatch: { correlationId: "r", resultSignal: "x" },
        cost: { estimateUsd: 1.2 },
      };
    },
  };
  for (const s of [
    shot({ duration: 7 }),
    shot({ line: "hi", speaker: "the keeper" }),
  ]) {
    const job = {
      index: 0,
      shot: s,
      plateFileId: "plate",
      character: "c",
      bible: "b",
    };
    const { ctx: c } = ctx(
      { job, keyframeFileId: "kf" },
      { contentGeneration: { video } },
    );
    await agent.steps.animate.run({}, c);
  }
  assert.equal(calls[0].model, "seedance-i2v");
  assert.equal(calls[0].referenceImage, "kf");
  assert.equal(calls[0].duration, 7);
  assert.equal(calls[0].audio, false);
  assert.equal("aspectRatio" in calls[0], false);
  assert.equal(calls[1].audio, true);
  assert.match(calls[1].prompt, /"hi"$/);
});

test("clip fails loudly on a generation error rather than returning an empty shot", async () => {
  const job = {
    index: 1,
    shot: shot(),
    plateFileId: "p",
    character: "c",
    bible: "b",
  };
  const { ctx: c } = ctx({ job, childWarnings: [] });
  await assert.rejects(
    agent.steps.clip.run(
      { outputs: [{ generationError: "provider timeout" }] },
      c,
    ),
    /clip generation failed for shot 2: provider timeout/,
  );
});

test("stitch skips the merge for one shot and merges several in order", async () => {
  const one = ctx({ results: [shotResult(0)] });
  const d1 = await agent.steps.stitch.run({}, one.ctx);
  assert.deepEqual(d1.input, { videoFileId: "clip-0" });

  const calls = [];
  const many = ctx(
    { results: [shotResult(0), null, shotResult(2)], costUsd: 5 },
    {
      contentGeneration: {
        video: {
          create: async (spec) => {
            calls.push(spec);
            return { video: { fileId: "merged" }, cost: { estimateUsd: 0.1 } };
          },
        },
      },
    },
  );
  const d2 = await agent.steps.stitch.run({}, many.ctx);
  assert.deepEqual(d2.input, { videoFileId: "merged" });
  assert.deepEqual(calls[0].passthrough.video_urls, [
    fileStorage.getPublicUrl("clip-0"),
    fileStorage.getPublicUrl("clip-2"),
  ]);
  assert.equal(calls[0].model, "fal-ai/ffmpeg-api/merge-videos");
  assert.equal(many.shared.get("costUsd"), 5.1);
});

test("stitch fails the run when every shot failed", async () => {
  const { ctx: c } = ctx({ results: [null, null], warnings: ["x"] });
  const d = await agent.steps.stitch.run({}, c);
  assert.equal(d.kind, "fail");
});

function plateCtx(verdicts) {
  const creates = [];
  let n = 0;
  const env = ctx(
    {
      plan: { character: "keeper", bible: "look", shots: [shot()] },
      aspectRatio: "16:9",
      warnings: [],
    },
    {
      contentGeneration: {
        images: {
          create: async (spec) => {
            creates.push(spec);
            return {
              images: [{ fileId: `plate-${creates.length}` }],
              cost: { estimateUsd: 0.15 },
            };
          },
        },
      },
      llm: { run: async () => ({}), structuredOf: () => verdicts[n++] },
    },
  );
  return { ...env, creates };
}

test("plate redoes a multi-figure plate once with a per-attempt key", async () => {
  const {
    ctx: c,
    shared,
    creates,
  } = plateCtx([
    { people: 3, has_text_or_panels: false },
    { people: 1, has_text_or_panels: false },
  ]);
  const d = await agent.steps.plate.run({}, c);
  assert.equal(d.stepName, "shots");
  assert.deepEqual(
    creates.map((x) => x.idempotencyKey),
    ["exec-1:plate:1", "exec-1:plate:2"],
  );
  assert.match(creates[1].prompt, /draw the person once/);
  assert.equal(shared.get("plateFileId"), "plate-2");
  assert.equal(shared.get("costUsd"), 0.3);
  assert.deepEqual(shared.get("warnings"), []);
});

test("plate accepts a second bad plate with a warning instead of failing", async () => {
  const {
    ctx: c,
    shared,
    creates,
  } = plateCtx([
    { people: 3, has_text_or_panels: false },
    { people: 2, has_text_or_panels: true },
  ]);
  await agent.steps.plate.run({}, c);
  assert.equal(creates.length, 2);
  assert.match(
    shared.get("warnings")[0],
    /still shows 2 figure\(s\) with text or panels after a redo/,
  );
});

test("plate uses a good first plate without a second render", async () => {
  const { ctx: c, creates } = plateCtx([
    { people: 1, has_text_or_panels: false },
  ]);
  await agent.steps.plate.run({}, c);
  assert.equal(creates.length, 1);
});

test("runStructured retries a reply without the tool call and adds the tool-only instruction", async () => {
  const requests = [];
  const answers = [undefined, undefined, { ok: true }];
  let n = 0;
  const { ctx: c } = ctx(
    {},
    {
      llm: {
        run: async (r) => (requests.push(r), { stop_reason: "end_turn" }),
        structuredOf: () => answers[n++],
      },
    },
  );
  const out = await runStructured(
    c,
    { system: "Be strict.", messages: [], max_tokens: 10 },
    { name: "t", schema: {} },
  );
  assert.deepEqual(out, { ok: true });
  assert.equal(requests.length, 3);
  assert.equal(
    requests[0].request.system,
    "Be strict. Answer only by calling the t tool. Never answer in text.",
  );
  assert.deepEqual(requests[0].output, { name: "t", schema: {} });
});

test("runStructured gives up after three prose replies", async () => {
  let calls = 0;
  const { ctx: c } = ctx(
    {},
    { llm: { run: async () => (calls++, {}), structuredOf: () => undefined } },
  );
  assert.equal(
    await runStructured(
      c,
      { messages: [], max_tokens: 10 },
      { name: "t", schema: {} },
    ),
    undefined,
  );
  assert.equal(calls, 3);
});

test("when both keyframes fail, the better attempt is animated, not the last", async () => {
  const good = {
    same_person: true,
    clothing_matches: true,
    palette_matches: true,
    composition_matches: false,
    score: 8,
    issues: "framing",
  };
  const worse = {
    same_person: true,
    clothing_matches: false,
    palette_matches: true,
    composition_matches: true,
    score: 5,
    issues: "cap missing",
  };
  assert.equal(pickBestAttempt([good, worse]), 0);
  assert.equal(pickBestAttempt([null, worse]), 1);
  assert.equal(
    pickBestAttempt([
      { ...good, score: 6 },
      { ...good, score: 7 },
    ]),
    1,
  );

  const job = {
    index: 3,
    shot: shot(),
    plateFileId: "plate",
    character: "c",
    bible: "b",
  };
  const { ctx: c, shared } = ctx(
    {
      job,
      keyframeAttempt: 2,
      keyframeFileId: "kf2",
      keyframeIds: ["kf1", "kf2"],
      checks: [good],
      childWarnings: [],
    },
    { llm: { run: async () => ({}), structuredOf: () => worse } },
  );
  const d = await agent.steps.check.run({}, c);
  assert.equal(d.stepName, "animate");
  assert.equal(shared.get("keyframeFileId"), "kf1");
  assert.equal(shared.get("lastCheck").score, 8);
  assert.match(
    shared.get("childWarnings")[0],
    /used attempt 1 of 2 \(score 8\/10: framing\)/,
  );
});

test("runStructured retries a failed call and rethrows only when every attempt fails", async () => {
  let n = 0;
  const flaky = ctx(
    {},
    {
      llm: {
        run: async () => {
          if (n++ === 0) throw new Error("502 upstream_unavailable");
          return {};
        },
        structuredOf: () => ({ ok: true }),
      },
    },
  );
  assert.deepEqual(
    await runStructured(
      flaky.ctx,
      { messages: [], max_tokens: 10 },
      { name: "t", schema: {} },
    ),
    { ok: true },
  );

  const down = ctx(
    {},
    {
      llm: {
        run: async () => {
          throw new Error("502 upstream_unavailable");
        },
        structuredOf: () => undefined,
      },
    },
  );
  await assert.rejects(
    runStructured(
      down.ctx,
      { messages: [], max_tokens: 10 },
      { name: "t", schema: {} },
    ),
    /502/,
  );
});
