// =============================================================================
// scripts/examples-copy-check.mjs
//
// House-style rules for the copy a buyer actually reads. Name/mechanism rules
// target `name` (registry) and `whatItDoes` (manifest); terminology checks walk
// every relayed registry/manifest string plus the clone-facing authoring and
// source assets selected by `examples-check.mjs`.
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
// under them — ajv reports those with a JSON pointer. This file carries the
// rules JSON Schema cannot express readably: a `pattern` can reject copy but
// cannot say WHICH word is the problem, which is the whole value of the message.
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

const MECHANISM_RE = new RegExp(
  `(?<![a-z])(${MECHANISM_WORDS.join("|")})(?![a-z])`,
  "i",
);

const WORKFLOW_TERM_RE = /\bworkflows?\b/i;
const ORCHESTRATION_TERM_RE = /\borchestrations?\b/i;
const PROJECT_DEPLOYABLE_TERM_RE = /\b(?:workflows?|orchestrations?)\b/i;
const LOCAL_RUN_TERM_RE = /\b(?:run_local|local run)\b/i;
const OVERBROAD_LOCAL_RUN_GUARANTEE_RE =
  /\b(?:offline|for free|zero[- ]cost|no cost)\b/i;
const UNSUPPORTED_RUN_INSPECTOR_CONTROL_RE = /\bResume run\b/i;

function overbroadLocalRunClaims(source) {
  const lines = String(source).split(/\r?\n/);
  const claims = [];
  for (let index = 0; index < lines.length; index++) {
    const guarantee = OVERBROAD_LOCAL_RUN_GUARANTEE_RE.exec(lines[index]);
    if (!guarantee) continue;
    const nearby = lines
      .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
      .join("\n");
    if (LOCAL_RUN_TERM_RE.test(nearby)) {
      claims.push({ line: index + 1, guarantee: guarantee[0] });
    }
  }
  return claims;
}

const REGISTERED_PROJECT_COPY_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const REGISTERED_PROJECT_COPY_IGNORED_DIRS = new Set([
  ".git",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test",
  "tests",
]);

const REGISTERED_PROJECT_COPY_LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/**
 * Generated, dependency, and test trees are not part of the project prose a
 * template customer or coding agent authors. Keep this path rule narrow and
 * segment-based so a legitimate source file such as `src/contest.ts` is not
 * skipped by a substring match.
 */
export function isRegisteredProjectCopyPathIgnored(assetPath) {
  return assetPath
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => REGISTERED_PROJECT_COPY_IGNORED_DIRS.has(segment));
}

/**
 * The clone-facing prose/source surface under a registered `sourcePath`.
 * Extension allowlisting avoids trying to decode binary assets, while explicit
 * test and lockfile exclusions keep fixture/history text out of the product
 * terminology contract.
 */
export function isRegisteredProjectCopyAsset(assetPath) {
  const normalized = assetPath.replaceAll("\\", "/");
  if (isRegisteredProjectCopyPathIgnored(normalized)) return false;

  const basename = normalized.split("/").at(-1) ?? "";
  if (REGISTERED_PROJECT_COPY_LOCKFILES.has(basename)) return false;
  if (/\.(?:spec|test)\./i.test(basename)) return false;
  if (basename === "package.json") return true;

  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  return REGISTERED_PROJECT_COPY_EXTENSIONS.has(extension);
}

/**
 * Checks one text asset copied from a registered project. Unlike registry and
 * manifest projection fields, these assets include coding-agent instructions,
 * source comments, and runtime metadata such as Zod `.describe(...)` strings.
 */
export function checkRegisteredProjectCopyAsset(template, assetPath, source) {
  const id = template?.id ?? "(unknown)";
  const errors = [];
  const lines = String(source).split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const match = PROJECT_DEPLOYABLE_TERM_RE.exec(
      withoutCompatibilityLiterals(lines[index]),
    );
    if (!match) continue;
    errors.push(
      `copy-project-terminology: "${id}" ${assetPath}:${index + 1} contains human-readable "${match[0]}" terminology — use Agent for the deployable definition and Agent run for an execution.`,
    );
  }

  // Local Run replaces only `ctx.sapiom.*` calls. It still executes the
  // project's JavaScript, so authored network / file / process side effects
  // stay real unless that project guards them. Check a small line window so
  // wrapped Markdown cannot turn that boundary into a blanket offline/free
  // guarantee. "No Sapiom capability spend" is intentionally allowed.
  for (const claim of overbroadLocalRunClaims(source)) {
    errors.push(
      `copy-local-run-boundary: "${id}" ${assetPath}:${claim.line} describes Local Run as "${claim.guarantee}" — say that Sapiom capabilities are stubbed and name any project-specific dry-run guards; authored code and its side effects still execute.`,
    );
  }

  for (let index = 0; index < lines.length; index++) {
    if (!UNSUPPORTED_RUN_INSPECTOR_CONTROL_RE.test(lines[index])) continue;
    errors.push(
      `copy-unsupported-control: "${id}" ${assetPath}:${index + 1} promises a Resume run control that Run Inspector does not expose — use sapiom_dev_agents_signal or the API.`,
    );
  }

  return errors;
}

/**
 * These are compatibility-sensitive API and tool identifiers, not product
 * prose. Remove them before checking a string so the surrounding sentence is
 * still held to the Agent / Agent run terminology contract.
 */
const COMPATIBILITY_LITERALS = [
  /\/v1\/workflows(?:\/[a-z0-9._~!$&'()*+,;=:@%-]+)*/gi,
  /\/api\/workflows(?:\/[a-z0-9._~!$&'()*+,;=:@%-]+)*/gi,
  /sapiom_workflow_[a-z0-9_]+/gi,
  /workflow_signal/gi,
  /signal_workflow/gi,
];

function withoutCompatibilityLiterals(value) {
  return COMPATIBILITY_LITERALS.reduce(
    (copy, literal) => copy.replace(literal, ""),
    value,
  );
}

function* stringValues(value, path = "$", seen = new Set()) {
  if (typeof value === "string") {
    yield [path, value];
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* stringValues(value[i], `${path}[${i}]`, seen);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    yield* stringValues(child, `${path}.${key}`, seen);
  }
}

function registryDisplayCopy(template) {
  return {
    name: template?.name,
    description: template?.description,
    tags: template?.tags,
    category: template?.category,
    discipline: template?.discipline,
    cadence: template?.cadence,
    steps: Array.isArray(template?.steps)
      ? template.steps.map((step) => ({
          name: step?.name,
          description: step?.description,
        }))
      : [],
    setup: {
      degradedWithoutSetup: template?.setup?.degradedWithoutSetup,
    },
  };
}

function registryProseCopy(template) {
  const { tags: _mechanismTags, ...prose } = registryDisplayCopy(template);
  return prose;
}

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

  for (const [surface, value, terminology] of [
    ["registry", registryDisplayCopy(template), WORKFLOW_TERM_RE],
    ["registry", registryProseCopy(template), ORCHESTRATION_TERM_RE],
    ["manifest", manifest, PROJECT_DEPLOYABLE_TERM_RE],
  ]) {
    for (const [path, copy] of stringValues(value)) {
      if (!terminology.test(withoutCompatibilityLiterals(copy))) continue;
      fail(
        "copy-terminology",
        `${surface}${path.slice(1)} contains human-readable Workflow/orchestration terminology — use Agent for the deployable definition and Agent run for an execution.`,
      );
    }
  }

  for (const [path, copy] of stringValues(manifest)) {
    for (const claim of overbroadLocalRunClaims(copy)) {
      fail(
        "copy-local-run-boundary",
        `manifest${path.slice(1)}:${claim.line} describes Local Run as "${claim.guarantee}" — say that Sapiom capabilities are stubbed and name any project-specific dry-run guards; authored code and its side effects still execute.`,
      );
    }
    if (UNSUPPORTED_RUN_INSPECTOR_CONTROL_RE.test(copy)) {
      fail(
        "copy-unsupported-control",
        `manifest${path.slice(1)} promises a Resume run control that Run Inspector does not expose — use sapiom_dev_agents_signal or the API.`,
      );
    }
  }

  return errors;
}
