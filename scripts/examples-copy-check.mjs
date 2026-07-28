// =============================================================================
// scripts/examples-copy-check.mjs
//
// House-style rules for the copy a buyer actually reads: `name`, `description`,
// `whatItDoes` (registry) and `useCases` (manifest).
//
// Why these are rules and not just guidance in AUTHORING.md: every prose field
// in both schemas is `{ "type": "string" }` with no constraint of any kind, so
// the house style has only ever lived in prose no tool reads. 26 templates
// drifted 26 directions — 11 names carry a mechanism word, 5 contain an arrow
// or a slash doing a description's job, 19 of 26 `whatItDoes` open with "For",
// and the SHORTEST of 79 use cases is 62 characters where the card has room for
// ~27. That is the same failure as `requiredSecrets`: a rule that existed and
// nothing checked.
//
// The mechanism-word rule is not new policy. `registry.schema.json`'s `category`
// description already states it — "The axis is OUTCOME ... Mechanism words
// (durable, pause-resume, hitl, evals, media, orchestration) stay in freeform
// `tags`" — and we enforced it only on `category`, where an enum made it free.
// This applies the same rule to the field a user reads and searches.
//
// EVERYTHING HERE IS A WARNING, not an error, and deliberately so: all four
// limits fail all 26 templates today, so a gate would block every PR. This is
// the same play `examples-check.mjs` already runs for `category`/`cadence`
// ("a nudge, not a gate — flip to errors.push once every template carries
// them"). The warning count is the burn-down. When it reaches zero, move the
// length caps into the schemas as `maxLength` and flip the style rules to
// errors; until then a schema `maxLength` would be a hard failure on day one.
// =============================================================================

/**
 * Length caps, in characters. Sized from the rendered card, not from taste:
 * a name that wraps the card title, a description that wraps the subtitle to
 * three lines, or a use case that can't sit on one chip is a layout bug the
 * schema is letting through.
 */
export const COPY_LIMITS = {
  name: 32,
  description: 160,
  whatItDoes: 320,
  useCase: 40,
};

/**
 * Words that name the machinery rather than the job. Deliberately narrow: it
 * flags implementation vocabulary a buyer would never search for, and leaves
 * plain-English product words (Bot, Autopilot, Digest, Roundup) alone. Each one
 * belongs in `tags`, which already drives search — the name is not where a
 * mechanism becomes findable.
 */
export const MECHANISM_WORDS = [
  "saga",
  "engine",
  "pipeline",
  "runner",
  "endpoint",
  "gate",
  "durable",
  "keep-alive",
  "multi-party",
  "human-in-the-loop",
  "orchestrator",
  "daemon",
  "worker",
  "handler",
];

const MECHANISM_RE = new RegExp(`(?<![a-z])(${MECHANISM_WORDS.join("|")})(?![a-z])`, "i");

/**
 * Copy rules for one template.
 *
 * @param template  the registry entry (name, description, whatItDoes, tags)
 * @param manifest  the co-located template.json, or null when unreadable
 * @returns string[] of warnings, each naming the template, the field, and the fix
 */
export function checkCopy(template, manifest) {
  const warnings = [];
  const id = template?.id ?? "(unknown)";
  const warn = (rule, message) => warnings.push(`${rule}: "${id}" ${message}`);

  const name = typeof template?.name === "string" ? template.name : "";
  if (name.length > COPY_LIMITS.name) {
    warn(
      "copy-name",
      `name is ${name.length} chars (max ${COPY_LIMITS.name}) — "${name}" will wrap the card title.`,
    );
  }
  if (/[→/]/.test(name)) {
    warn(
      "copy-name",
      `name "${name}" contains an arrow or a slash — that is a description's job. Pick the one thing it produces.`,
    );
  }
  if (/\(.*\)/.test(name)) {
    warn(
      "copy-name",
      `name "${name}" carries a parenthetical — nobody searches for the part in brackets. Move it to \`tags\`.`,
    );
  }
  const mechanism = MECHANISM_RE.exec(name);
  if (mechanism) {
    warn(
      "copy-name",
      `name "${name}" is built on the mechanism word "${mechanism[1]}" — the axis is the OUTCOME, not the machinery. Move "${mechanism[1].toLowerCase()}" to \`tags\`, which is what drives search.`,
    );
  }

  const description =
    typeof template?.description === "string" ? template.description : "";
  if (description.length > COPY_LIMITS.description) {
    warn(
      "copy-description",
      `description is ${description.length} chars (max ${COPY_LIMITS.description}) — one plain sentence, not two.`,
    );
  }

  const whatItDoes =
    typeof template?.whatItDoes === "string" ? template.whatItDoes : "";
  if (whatItDoes.length > COPY_LIMITS.whatItDoes) {
    warn(
      "copy-what-it-does",
      `whatItDoes is ${whatItDoes.length} chars (max ${COPY_LIMITS.whatItDoes}) — the card shows about three sentences.`,
    );
  }
  if (/^For\b/.test(whatItDoes)) {
    warn(
      "copy-what-it-does",
      `whatItDoes opens with "For" — lead with the verb ("Create a cited account brief…"), not with who it is for.`,
    );
  }

  const useCases = Array.isArray(manifest?.useCases) ? manifest.useCases : [];
  useCases.forEach((useCase, i) => {
    if (typeof useCase === "string" && useCase.length > COPY_LIMITS.useCase) {
      warn(
        "copy-use-case",
        `useCases[${i}] is ${useCase.length} chars (max ${COPY_LIMITS.useCase}) — a short noun phrase ("Relationship graph"), not a sentence.`,
      );
    }
  });

  return warnings;
}
