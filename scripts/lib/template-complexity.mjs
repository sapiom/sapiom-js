// =============================================================================
// scripts/lib/template-complexity.mjs
//
// The DERIVED complexity scorer, as a guardrail for the AUTHORED `complexity`
// band in `examples/registry.json`.
//
// This is a port of the Sapiom backend's `template-complexity.ts` (SAP-2085).
// It reads nothing but a registry entry — no network, no filesystem — so the
// port is a pure-function copy rather than a shared dependency; the two repos
// have no build relationship to hang a package off. The weights and band edges
// below are the one source of truth on THIS side of that line: keep them in
// sync with the backend module when either changes, and the divergence check in
// `examples-check.mjs` will tell you loudly if a template's shape and its label
// have drifted apart.
//
// WHY it is a guardrail and not the answer: derivation is a proxy for what the
// band actually communicates — how much variation and judgment is in a
// template's output. The proxy reads only `kind` and `capabilities`, so it is
// blind to judgment that arrives any other way. `web-research-digest` is the
// standing example: it derives `minimal` (no `llm` step — its `summarize` step
// really is a pure formatter) while the whole product a user reads is the
// model-written `answer` that `web.search` returned, so its authored band is
// `simple`. A 2+ band gap therefore means one of two things, both worth a human
// look: the label is wrong, or the DECLARED SHAPE is wrong (a mis-declared
// `kind` also corrupts the gallery's step glyphs, so catching it pays for
// itself).
// =============================================================================

/**
 * Media generation, which produces a high-variance artifact.
 *
 * Both spellings are intentional: the catalog ids are dotted
 * (`content.generation.images`) but the registry currently declares the
 * camelCase near-miss `contentGeneration.images`. Matching one spelling only
 * would make the scorer quietly wrong on whichever side of that fix it is not.
 *
 * `models.run` / `models.coding` are deliberately absent — a step calling
 * either is already declared `kind: "llm"` and counted as a judgment point, so
 * counting both would double-weight the same signal.
 */
const MEDIA_CAPABILITIES = new Set([
  "content.generation.images",
  "content.generation.video",
  "contentGeneration.images",
  "contentGeneration.video",
]);

/**
 * Weights. Judgment dominates; size is a nudge; topology is deliberately the
 * lightest term — a wide fan-out of deterministic branches is not what makes a
 * workflow hard to reason about. This ordering is the axis the AUTHORING rubric
 * asks authors to apply by hand.
 */
const WEIGHT = {
  llmStep: 4,
  chainedLlmStep: 3,
  mediaCapability: 3,
  capability: 0.4,
  step: 0.2,
  /** Applied to `maxFanOut - 1`, so a linear workflow contributes nothing. */
  fanOut: 0.2,
};

/** Upper bound (exclusive) of each band, ascending. Same edges as the backend. */
const BANDS = [
  { max: 1.5, score: 1, label: "minimal" },
  { max: 4, score: 2, label: "simple" },
  { max: 7, score: 3, label: "moderate" },
  { max: 11, score: 4, label: "involved" },
  { max: Number.POSITIVE_INFINITY, score: 5, label: "advanced" },
];

/** The authored enum, ascending — index + 1 is the band's numeric score. */
export const COMPLEXITY_BANDS = [
  "minimal",
  "simple",
  "moderate",
  "involved",
  "advanced",
];

/** Numeric score (1–5) of an authored band, or `null` if it isn't a known band. */
export function complexityBandScore(label) {
  const index = COMPLEXITY_BANDS.indexOf(label);
  return index === -1 ? null : index + 1;
}

function basisOf(template) {
  const steps = Array.isArray(template.steps) ? template.steps : [];
  const capabilities = Array.isArray(template.capabilities)
    ? template.capabilities
    : [];

  // A chained pair is an `llm` step continuing into another `llm` step. Counted
  // per edge, not per step, so a model step fanning out to two more counts
  // twice — two independent compounding paths. An unresolvable `next` target
  // simply matches nothing (this must not throw on a malformed registry, which
  // the other checks in examples-check.mjs report on their own terms).
  const kindByName = new Map(steps.map((step) => [step.name, step.kind]));
  let chainedLlmSteps = 0;
  for (const step of steps) {
    if (step.kind !== "llm") continue;
    for (const target of step.next ?? []) {
      if (kindByName.get(target) === "llm") chainedLlmSteps += 1;
    }
  }

  return {
    llmSteps: steps.filter((step) => step.kind === "llm").length,
    chainedLlmSteps,
    mediaCapabilities: capabilities.filter((id) => MEDIA_CAPABILITIES.has(id))
      .length,
    capabilityCount: capabilities.length,
    stepCount: steps.length,
    maxFanOut: steps.reduce(
      (max, step) => Math.max(max, (step.next ?? []).length),
      0,
    ),
  };
}

/** The raw weighted sum. Exposed so a divergence report can show its work. */
export function templateComplexityRawScore(basis) {
  const raw =
    WEIGHT.llmStep * basis.llmSteps +
    WEIGHT.chainedLlmStep * basis.chainedLlmSteps +
    WEIGHT.mediaCapability * basis.mediaCapabilities +
    WEIGHT.capability * basis.capabilityCount +
    WEIGHT.step * basis.stepCount +
    WEIGHT.fanOut * Math.max(0, basis.maxFanOut - 1);
  // One decimal: the inputs are small integers, so this only trims float noise.
  return Math.round(raw * 10) / 10;
}

/**
 * Score a registry entry's complexity from its declared shape.
 *
 * Total-function by contract: an entry with no steps and no capabilities scores
 * `minimal` rather than throwing.
 */
export function scoreTemplateComplexity(template) {
  const basis = basisOf(template);
  const raw = templateComplexityRawScore(basis);
  // BANDS is ascending and ends at +Infinity, so this always matches.
  const band =
    BANDS.find((candidate) => raw < candidate.max) ?? BANDS[BANDS.length - 1];
  return { score: band.score, label: band.label, raw, basis };
}
