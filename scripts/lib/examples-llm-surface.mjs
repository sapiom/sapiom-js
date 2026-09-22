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

/**
 * The floor a structured `llm.run` cap has to clear (SAP-3280).
 *
 * A routed label emits a `thinking` block before the forced tool call and those tokens are
 * spent out of `max_tokens`, so a cap sized for the answer alone can end the turn before the
 * tool call is emitted — leaving nothing to read, on the hardest inputs only. This is a floor,
 * not the recommendation: the examples use 4096. What it forbids is the order of magnitude
 * that starves the call.
 */
export const STRUCTURED_CAP_FLOOR = 2048;

/**
 * The opening of an `llm.run` call: optional type arguments (`llm.run<Verdict>(`), optional
 * whitespace before the parenthesis, and whatever follows it — the spec may open on the same
 * line or the next. The type-argument class is anything but parentheses, so `<Array<T>>` is
 * covered without a real parser.
 */
const LLM_RUN_OPEN = /\bllm\.run\s*(?:<[^()]*>)?\s*\(/;
/** A literal cap, or the identifier holding one — `max_tokens: LEAF_MAX_TOKENS` is the idiom here. */
const CAP_ASSIGNMENT = /max_tokens\s*:\s*([A-Za-z_$][\w$]*|\d[\d_]*)/;
const NUMERIC_CONST =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*;/g;

/** In-file `const NAME = 700;` declarations, so a named cap is read as the number it is. */
export function numericConstsOf(source) {
  const consts = new Map();
  for (const [, name, value] of source.matchAll(NUMERIC_CONST)) {
    consts.set(name, Number(value.replaceAll("_", "")));
  }
  return consts;
}

/**
 * The number a `max_tokens:` value stands for — the literal itself, or the in-file const it
 * names — or `undefined` when it is neither (imported, computed).
 */
export function resolveCap(cap, consts) {
  return /^\d/.test(cap) ? Number(cap.replaceAll("_", "")) : consts.get(cap);
}

/**
 * Every `max_tokens:` in `source` resolved to a number, with the line it sits on. A value that
 * cannot be resolved is left out, the same way {@link checkStructuredOutputCap} skips it.
 */
export function resolvedCapsOf(source) {
  const consts = numericConstsOf(source);
  const caps = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const hit = CAP_ASSIGNMENT.exec(lines[i]);
    if (!hit) continue;
    const value = resolveCap(hit[1], consts);
    if (value !== undefined) caps.push({ line: i + 1, value });
  }
  return caps;
}

/**
 * The index of the line on which the parenthesis opened at `lines[start]` (from `column`) is
 * closed again — the extent of one call. Parentheses inside a `'…'` / `"…"` string, a
 * template literal (including nested `${…}` expressions and their own strings), a `//`
 * comment or a `/* … *\/` comment are not counted, because a prompt reads "(1-5)" or ":)"
 * often enough that an early false close would hide `output` and `max_tokens` from the check.
 * Braces and brackets are balanced inside a well-formed argument list, so only parentheses
 * are tracked. A regex literal containing a parenthesis is the accepted edge — telling `/`
 * the operator from `/` the delimiter needs a parser, and no template writes a regex inside
 * its `llm.run` call. Runs to the end of the file when the call never closes.
 */
function callEndOf(lines, start, column) {
  let depth = 0;
  // Lexical context stack: a quote character for a string, "${" for a template
  // expression, "{" for a brace nested inside one, "//" or "/*" for a comment.
  const modes = [];
  const top = () => modes[modes.length - 1];

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (top() === "//") modes.pop();
    for (let c = i === start ? column : 0; c < line.length; c += 1) {
      const ch = line[c];
      const next = line[c + 1];
      const mode = top();

      if (mode === "/*") {
        if (ch === "*" && next === "/") {
          modes.pop();
          c += 1;
        }
        continue;
      }
      if (mode === "'" || mode === '"') {
        if (ch === "\\") c += 1;
        else if (ch === mode) modes.pop();
        continue;
      }
      if (mode === "`") {
        if (ch === "\\") c += 1;
        else if (ch === "`") modes.pop();
        else if (ch === "$" && next === "{") {
          modes.push("${");
          c += 1;
        }
        continue;
      }

      // Code: the call itself, or an expression inside a template literal.
      if (ch === "/" && next === "/") {
        modes.push("//");
        break;
      }
      if (ch === "/" && next === "*") {
        modes.push("/*");
        c += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        modes.push(ch);
        continue;
      }
      if (mode === "${" || mode === "{") {
        // Inside a template expression its parentheses are balanced and belong to it,
        // so only the braces that lead back out to the template are tracked.
        if (ch === "{") modes.push("{");
        else if (ch === "}") modes.pop();
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")" && (depth -= 1) === 0) return i;
    }
    // A quoted string cannot span lines; an unterminated one is a typo, not a context.
    if (top() === "'" || top() === '"') modes.pop();
  }
  return lines.length - 1;
}

/**
 * Reject a structured `llm.run` whose cap thinking can exhaust — in a template source or in
 * a fenced snippet under `examples/`, since both are copied verbatim by the next author.
 *
 * Scoped to the call it reads, not the file: a plain-text call bounded on purpose (a
 * `textOf` reply capped at 700) is legitimate and left alone. Only a call that also declares
 * `output` is judged, because that is the one whose failure is silent.
 *
 * A named cap is resolved against the file's own `const NAME = <number>` declarations —
 * `max_tokens: LEAF_MAX_TOKENS` is already the idiom in `fan-out-and-combine`, and a check that
 * only read digits would have been bypassed by writing the starved number one line higher. The
 * call is found by its opening parenthesis and read to the matching close, so a generic call
 * (`llm.run<Verdict>(`), a spec that opens on the next line, and a one-line call are all one
 * call each. What it still cannot see is a cap imported from another module or computed at
 * runtime, or a call made through an alias (`const ask = ctx.sapiom.llm.run`); those are the
 * known edges, and the templates do not do them.
 *
 * @param path    repository-relative path, for the message
 * @param source  the file's contents
 * @returns string[] of problems, one per offending call
 */
export function checkStructuredOutputCap({ path, source }) {
  const errors = [];
  const lines = source.split("\n");
  const consts = numericConstsOf(source);

  for (let i = 0; i < lines.length; i += 1) {
    const open = LLM_RUN_OPEN.exec(lines[i]);
    if (!open) continue;

    const end = callEndOf(lines, i, open.index + open[0].length - 1);
    let capLine = -1;
    let declaresOutput = false;
    for (let j = i; j <= end; j += 1) {
      if (/\boutput\s*:/.test(lines[j])) declaresOutput = true;
      if (capLine === -1 && CAP_ASSIGNMENT.test(lines[j])) capLine = j;
    }
    // The next call starts after this one; a line may hold at most one `llm.run(`.
    i = end;
    if (!declaresOutput || capLine === -1) continue;

    const value = resolveCap(CAP_ASSIGNMENT.exec(lines[capLine])[1], consts);
    if (value === undefined || value >= STRUCTURED_CAP_FLOOR) continue;

    errors.push(
      `llm-surface: ${path}:${capLine + 1} caps a structured llm.run at ${value} tokens. ` +
        "Thinking is spent out of the same budget, so a cap this size can end the turn before " +
        "the forced tool call is emitted — the structured result then never arrives, on the " +
        "hardest inputs only (SAP-3280). Size it for thinking plus output " +
        `(at least ${STRUCTURED_CAP_FLOOR}; the examples use 4096); billing settles on the tokens ` +
        "actually produced.",
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

/**
 * Steps whose `llm.run` passes a structured-output spec, keyed by step name →
 * the tool name it forces (or `null` when the name is an unresolvable
 * expression).
 *
 * Read statically from `index.ts`, the same way `checkEntrySchemaCoverage` and
 * `checkResourceReuse` already read it. Source is sliced on `defineStep(`
 * boundaries so the answer is PER STEP: `eval-gate` legitimately has a text
 * reply in `draft` and a forced tool call in `judge`, and a blanket
 * "this template uses structured output" answer would reject its `draft` stub.
 *
 * The match is `output: { name:` specifically, not a bare `output:` — that word
 * is an ordinary argument name elsewhere (`buildJudgePrompt({ input, output })`).
 */
export function structuredOutputStepsOf(indexSource, siblingSources = []) {
  const steps = new Map();
  // The tool-name const does not always live in index.ts — `news-roundup`
  // declares `SELECTION_TOOL` in `lib/select.ts` — so resolve across every
  // source the template ships.
  const allSources = [indexSource, ...siblingSources];
  const resolveConst = (identifier) => {
    for (const source of allSources) {
      const hit = source.match(
        new RegExp(`\\b${identifier}\\s*=\\s*"([^"]+)"`),
      );
      if (hit) return hit[1];
    }
    return null;
  };

  const chunks = indexSource.split(/defineStep\s*\(/);
  for (const chunk of chunks.slice(1)) {
    const name = chunk.match(/name:\s*"([A-Za-z0-9_]+)"/)?.[1];
    if (!name) continue;
    const spec = chunk.match(/output:\s*\{\s*name:\s*([A-Za-z0-9_]+|"[^"]+")/);
    if (!spec) continue;
    const raw = spec[1];
    steps.set(name, raw.startsWith('"') ? raw.slice(1, -1) : resolveConst(raw));
  }
  return steps;
}

/** The `tool_use` block names present in a stubbed `llm.run` reply. */
function toolUseNamesOf(reply) {
  const content = reply?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_use")
    .map((block) => block?.name);
}

/**
 * A committed `run_local` stub must answer in the shape its step actually reads.
 *
 * SAP-2892 — converting a step to `output` + `structuredOf` silently invalidates
 * any `llm.run` override for it: the old override returns a text block,
 * `structuredOf` reads `undefined`, and the reader throws. That breaks the local
 * flow the template's own README documents, and neither `examples:check` nor the
 * template's unit tests can see it — the checks read `.ts`, and the suites only
 * exercise the pure reader functions, never a graph.
 *
 * So this pairs the two files: for every step the stub overrides `llm.run` on,
 * if that step forces a tool call, the override must carry a `tool_use` block
 * with the matching name.
 *
 * @param id           template id, for the message
 * @param indexSource  the template's `index.ts`
 * @param stubPath     repository-relative path of the stub file, for the message
 * @param stubFile     the parsed stub JSON
 */
export function checkStubStructuredOutput({
  id,
  indexSource,
  siblingSources = [],
  stubPath,
  stubFile,
}) {
  const errors = [];
  const structuredSteps = structuredOutputStepsOf(indexSource, siblingSources);
  const steps = stubFile?.steps;
  if (!steps || typeof steps !== "object") return errors;

  for (const [stepName, overrides] of Object.entries(steps)) {
    const reply = overrides?.["llm.run"];
    if (reply === undefined) continue;
    if (!structuredSteps.has(stepName)) continue;

    const expected = structuredSteps.get(stepName);
    const names = toolUseNamesOf(reply);
    if (names.length === 0) {
      errors.push(
        `llm-surface: "${id}" step "${stepName}" forces a tool call, but ${stubPath} still stubs its ` +
          `llm.run with no tool_use block. structuredOf reads nothing from that reply and the step ` +
          `throws, so run_local can't trace the graph (SAP-2892). Stub it as ` +
          `{ "content": [{ "type": "tool_use", "name": "${expected ?? "<tool>"}", "input": { … } }] }.`,
      );
      continue;
    }
    if (expected && !names.includes(expected)) {
      errors.push(
        `llm-surface: "${id}" step "${stepName}" forces the tool "${expected}", but ${stubPath} stubs a ` +
          `tool_use block named ${names.map((n) => `"${n}"`).join(", ")}. structuredOf matches on the ` +
          `name, so the step throws under run_local.`,
      );
    }
  }
  return errors;
}
