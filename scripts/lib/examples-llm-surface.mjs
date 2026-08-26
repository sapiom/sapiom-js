export const ONE_SHOT_LLM_TEMPLATE_IDS = Object.freeze([
  "autonomous-pr",
  "cold-outreach-engine",
  "content-repurposing-pipeline",
  "dependency-upgrade",
  "error-triage-digest",
  "eval-gate",
  "fan-out-and-combine",
  "human-in-the-loop",
  "logged-in-screenshots",
  "meeting-notes-crm",
  "news-roundup",
  "newsletter-autopilot",
  "nl-db-query-endpoint",
  "pr-review-bot",
  "proposal-generator",
  "research-to-microsite",
  "scene-to-video",
  "scheduled-compliance-audit",
  "scheduled-db-insight-report",
  "scheduled-research-brief",
  "the-brain",
  "wait-for-webhook",
]);

const OLD_CALL = /ctx\.sapiom\.models\.run\s*\(/;
const NEW_CALL = /ctx\.sapiom\.llm\.run\s*\(/;
const FALSE_LLM_CLAIM =
  /ctx\.sapiom\.llm[^\n]{0,100}(?:does not|doesn't) exist/i;

/**
 * The slice-parse this repo has now removed everywhere: take the first `{` (or
 * `[`) to the last `}` (or `]`) of a model's prose reply and `JSON.parse` it.
 *
 * SAP-2892 — it is not salvageable by tightening the pattern. Any prose that
 * mentions a brace defeats it, LLM prose mentions braces constantly, and on
 * failure the templates substituted invented content (a verdict, a newsletter, a
 * priced quote) while reporting `succeeded`. The blessed replacement is
 * `LlmRunSpec.output` (a forced tool call) read back with
 * `ctx.sapiom.llm.structuredOf` — there is then nothing to slice.
 *
 * Matched per-line so the error can name the line, and matched on `indexOf` /
 * `lastIndexOf` rather than on `JSON.parse`: parsing JSON that arrived AS JSON
 * (an HTTP body, a file, a stub payload) is fine and common.
 */
const SLICE_PARSE = /\b(?:indexOf|lastIndexOf)\s*\(\s*(["'])[{}[\]]\1\s*\)/;

function requiresAtLeast(range, minimum) {
  const match = String(range ?? "")
    .trim()
    .match(/^(?:\^|~|>=)?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;

  const version = match.slice(1).map(Number);
  const floor = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > floor[i]) return true;
    if (version[i] < floor[i]) return false;
  }
  return true;
}

export function checkLlmCopySurface({ path, source }) {
  if (FALSE_LLM_CLAIM.test(source.replaceAll("*", ""))) {
    return [`llm-surface: ${path} falsely says ctx.sapiom.llm does not exist.`];
  }
  return [];
}

/**
 * Reject a first-`{`-to-last-`}` slice of a model reply in any template source.
 *
 * Unlike the `models.run` check this is NOT scoped to a known template list: the
 * point is that a NEW template cannot reintroduce the pattern, which is how the
 * call surface drifted back before. Applies to every `.ts` file under a
 * template, not just `index.ts`, because the parse has lived in a `lib/` helper
 * (`news-roundup/lib/select.ts`) and a sibling module
 * (`research-to-microsite/critique.ts`) as well.
 *
 * @param path    repository-relative path, for the message
 * @param source  the file's contents
 * @returns string[] of problems, one per offending line
 */
export function checkNoSliceParse({ path, source }) {
  const errors = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!SLICE_PARSE.test(lines[i])) continue;
    errors.push(
      `llm-surface: ${path}:${i + 1} slices a model reply from the first "{" to the last "}". ` +
        "That parse fails on any reply containing a stray brace, and every failure used to become " +
        "invented content on a run reported as succeeded (SAP-2892). Declare the shape with " +
        "`output: { name, schema }` on the llm.run spec and read it back with " +
        "`ctx.sapiom.llm.structuredOf(res, name)` instead.",
    );
  }
  return errors;
}

export function checkOneShotLlmTemplate({
  id,
  indexSource,
  copySources = [],
  packageJson,
  registryTemplate,
}) {
  const errors = [];
  if (OLD_CALL.test(indexSource)) {
    errors.push(
      `llm-surface: "${id}" still sends a one-shot call through ctx.sapiom.models.run; use ctx.sapiom.llm.run.`,
    );
  }
  if (!NEW_CALL.test(indexSource)) {
    errors.push(
      `llm-surface: "${id}" no longer contains its expected ctx.sapiom.llm.run call.`,
    );
  }

  for (const { path, source } of copySources) {
    if (source.includes("ctx.sapiom.models.run")) {
      errors.push(
        `llm-surface: "${id}" still teaches ctx.sapiom.models.run in ${path}.`,
      );
    }
    errors.push(...checkLlmCopySurface({ path: `"${id}" ${path}`, source }));
  }

  if (
    !requiresAtLeast(packageJson?.dependencies?.["@sapiom/tools"], "0.31.0")
  ) {
    errors.push(
      `llm-surface: "${id}" must require @sapiom/tools >= 0.31.0 for llm.run + textOf.`,
    );
  }
  if (
    !requiresAtLeast(packageJson?.dependencies?.["@sapiom/agent"], "0.12.0")
  ) {
    errors.push(
      `llm-surface: "${id}" must require @sapiom/agent >= 0.12.0 so ctx.sapiom exposes the matching tools surface.`,
    );
  }

  if (registryTemplate) {
    if (!registryTemplate.capabilities?.includes("llm.run")) {
      errors.push(
        `llm-surface: registered template "${id}" must declare llm.run in capabilities.`,
      );
    }
    if (registryTemplate.capabilities?.includes("models.run")) {
      errors.push(
        `llm-surface: registered template "${id}" still declares models.run in capabilities.`,
      );
    }
    for (const step of registryTemplate.steps ?? []) {
      if (step.capability === "models.run") {
        errors.push(
          `llm-surface: registered template "${id}" step "${step.name}" still declares models.run.`,
        );
      }
    }
  }

  return errors;
}
