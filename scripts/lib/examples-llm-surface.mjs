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

export function checkLlmCopySurface({ path, source }) {
  if (FALSE_LLM_CLAIM.test(source.replaceAll("*", ""))) {
    return [`llm-surface: ${path} falsely says ctx.sapiom.llm does not exist.`];
  }
  return [];
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

  if (packageJson?.dependencies?.["@sapiom/tools"] !== "^0.31.0") {
    errors.push(
      `llm-surface: "${id}" must depend on @sapiom/tools ^0.31.0 for llm.run + textOf.`,
    );
  }
  if (packageJson?.dependencies?.["@sapiom/agent"] !== "^0.12.0") {
    errors.push(
      `llm-surface: "${id}" must depend on @sapiom/agent ^0.12.0 so ctx.sapiom exposes the matching tools surface.`,
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
