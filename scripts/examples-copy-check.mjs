// =============================================================================
// scripts/examples-copy-check.mjs
//
// House-style rules for the copy a buyer actually reads: `name` (registry) and
// `whatItDoes` (manifest).
//
// Why these are rules and not guidance in AUTHORING.md: every prose field in
// both schemas used to be `{ "type": "string" }` with no constraint, so the
// house style only ever lived in prose no tool reads. 26 templates drifted 26
// directions — 11 names carried a mechanism word, 5 carried an arrow or slash
// doing a description's job, 19 of 26 `whatItDoes` opened with "For", and the
// shortest of 79 use cases was 62 characters where the card fits ~27.
//
// The mechanism-word rule is not new policy. `registry.schema.json`'s `category`
// description already said it — "The axis is OUTCOME ... Mechanism words
// (durable, pause-resume, hitl, evals, media, orchestration) stay in freeform
// `tags`" — and it was enforced only on `category`, where an enum made it free.
// This applies the same rule to the field a user reads and searches. Five of the
// eleven offending names repeated a word the SAME template already carried as a
// tag, so cutting it cost nothing in search.
//
// LENGTH IS NOT HERE. The caps live in the schemas as `maxLength` (name 32,
// description 160, whatItDoes 320, useCases[] 40) now that all 26 templates are
// under them — ajv reports those with a JSON pointer. This file carries only the
// two rules JSON Schema cannot express readably: a `pattern` can reject a name
// but cannot say WHICH word is the problem, which is the whole value of the
// message.
// =============================================================================

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
 * @param template  the registry entry (name, tags)
 * @param manifest  the co-located template.json (whatItDoes), or null
 * @returns string[] of problems, each naming the template and the fix
 */
export function checkCopy(template, manifest) {
  const errors = [];
  const id = template?.id ?? "(unknown)";
  const fail = (rule, message) => errors.push(`${rule}: "${id}" ${message}`);

  const name = typeof template?.name === "string" ? template.name : "";
  if (/[→/]/.test(name)) {
    fail(
      "copy-name",
      `name "${name}" contains an arrow or a slash — that is a description's job. Pick the one thing it produces.`,
    );
  }
  if (/\(.*\)/.test(name)) {
    fail(
      "copy-name",
      `name "${name}" carries a parenthetical — nobody searches for the part in brackets. Move it to \`tags\`.`,
    );
  }
  const mechanism = MECHANISM_RE.exec(name);
  if (mechanism) {
    fail(
      "copy-name",
      `name "${name}" is built on the mechanism word "${mechanism[1]}" — the axis is the OUTCOME, not the machinery. Move "${mechanism[1].toLowerCase()}" to \`tags\`, which is what drives search.`,
    );
  }

  const whatItDoes =
    typeof manifest?.whatItDoes === "string" ? manifest.whatItDoes : "";
  if (/^For\b/.test(whatItDoes)) {
    fail(
      "copy-what-it-does",
      `whatItDoes opens with "For" — lead with the verb ("Create a cited account brief…"), not with who it is for.`,
    );
  }

  return errors;
}
