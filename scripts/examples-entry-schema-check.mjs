// =============================================================================
// scripts/examples-entry-schema-check.mjs
//
// The `entry-schema` half of `pnpm examples:check`: the manifest's renderable
// projection of the entry input (`defaultInput` / `settings`) may only name
// paths the code's entry `inputSchema` actually declares.
//
// Why this is a check and not a convention: `defaultInput` / `settings` are the
// SHELF's projection of the entry contract — the UI cannot introspect a zod
// schema fetched from GitHub, so it renders from these instead (see
// examples/template.schema.json). The schema description states outright that
// this projection "NEVER overrides code": if it names a `deliverTo` the entry
// schema never declares, the form paints a field the run silently drops. That
// is exactly the class of bug SAP-2226 fixed by declaring the schema in the
// first place; this keeps the projection from drifting back off it.
//
// The entry step's inputSchema lives in TypeScript, and this check runs on the
// source tree with no compiler, so it reads the `z.object({ … })` literal's
// top-level keys statically. That is deliberately conservative:
//   - Entry step with NO `inputSchema` but a manifest that declares
//     `defaultInput`/`settings` → FAIL. A projection with nothing to project
//     onto is the drift this exists to catch.
//   - `inputSchema` present but not a plain `z.object({ … })` literal we can
//     read (built from a variable, a merge, a `z.union`, …) → SKIP coverage.
//     A parser limitation must never fail a valid template.
//   - Object literal read → every `settings[].path` root and every
//     `defaultInput` top-level key must be one of its keys.
//
// Exported (rather than inlined into examples-check.mjs) so the extraction and
// the rule are testable against fixtures without shelling out to the whole gate.
// =============================================================================

/**
 * Read the top-level keys of the entry step's `z.object({ … })` inputSchema.
 *
 * @param source  the example's `index.ts` contents
 * @returns
 *   - `null` — the file could not be analyzed (no `entry`, no matching step):
 *     the caller skips it.
 *   - `{ hasInputSchema: false, keys: null }` — the entry step declares no
 *     `inputSchema`.
 *   - `{ hasInputSchema: true, keys: null }` — an `inputSchema` is declared but
 *     its object literal could not be read (built from a variable / merge / …).
 *   - `{ hasInputSchema: true, keys: Set<string> }` — the declared keys.
 */
export function extractEntrySchema(source) {
  const entryMatch = source.match(/entry:\s*["']([^"']+)["']/);
  if (!entryMatch) return null;
  const entry = entryMatch[1];

  // The entry step's `defineStep({ … })` — matched up to its `name:` so the
  // slice that follows is that step's body, not another step's.
  const stepMatch = source.match(
    new RegExp(
      `const\\s+\\w+\\s*=\\s*defineStep\\(\\{[\\s\\S]*?name:\\s*["']${entry}["']`,
    ),
  );
  if (!stepMatch) return null;

  // Read forward only to the next step declaration, so an `inputSchema` on a
  // LATER step is never misattributed to the entry step.
  const rest = source.slice(stepMatch.index + stepMatch[0].length);
  const nextStep = rest.search(/\n\s*const\s+\w+\s*=\s*defineStep\(\{/);
  const stepBody = nextStep === -1 ? rest : rest.slice(0, nextStep);

  const schemaMatch = stepBody.match(/inputSchema:\s*([A-Za-z_$][\w$]*)/);
  if (!schemaMatch) return { hasInputSchema: false, keys: null };
  const ident = schemaMatch[1];

  // `const <ident> = … .object({` — allows `z.object`, `z\n  .object`, and a
  // schema that opens with `.meta(...)` etc. before `.object`.
  const declMatch = source.match(
    new RegExp(`const\\s+${ident}\\s*=[\\s\\S]*?\\.object\\(\\{`),
  );
  if (!declMatch) return { hasInputSchema: true, keys: null };

  const braceStart = declMatch.index + declMatch[0].length - 1; // at the `{`
  const inner = sliceBalanced(source, braceStart);
  if (inner === null) return { hasInputSchema: true, keys: null };

  return { hasInputSchema: true, keys: topLevelKeys(inner) };
}

/**
 * Given the index of an opening `{`, return the substring strictly between it
 * and its matching `}`, or null if the braces never balance.
 */
function sliceBalanced(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

/**
 * Top-level `key:` names inside an object-literal body — the identifiers that
 * sit at brace/paren/bracket depth 0, i.e. direct properties of the object.
 * Keys nested inside a field's own value (`z.object({ … })`, arrays, calls) are
 * at depth > 0 and are ignored.
 */
function topLevelKeys(inner) {
  const keys = new Set();
  let depth = 0;
  let token = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      token = "";
    } else if (c === "}" || c === ")" || c === "]") {
      depth--;
      token = "";
    } else if (depth === 0) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        token += c;
      } else if (c === ":") {
        if (token) keys.add(token);
        token = "";
      } else {
        token = "";
      }
    }
  }
  return keys;
}

/**
 * Verify a template's manifest projection against its entry schema.
 *
 * @param templateId  registry id, for the message
 * @param manifest    parsed template.json
 * @param source      the example's index.ts contents, or null if unreadable
 * @returns string[] of human-readable problems (empty when consistent or when
 *          conservatively skipped)
 */
export function checkEntrySchemaCoverage(templateId, manifest, source) {
  const settings = Array.isArray(manifest?.settings) ? manifest.settings : [];
  const defaultInput =
    manifest?.defaultInput && typeof manifest.defaultInput === "object"
      ? Object.keys(manifest.defaultInput)
      : [];
  if (settings.length === 0 && defaultInput.length === 0) return [];

  if (source == null) return [];
  const schema = extractEntrySchema(source);
  if (schema === null) return []; // could not analyze — skip, never false-fail.

  const where = `"${templateId}"`;
  if (!schema.hasInputSchema) {
    return [
      `entry-schema: ${where} declares ${describeProjection(settings, defaultInput)} but its entry step declares no \`inputSchema\` for them to project onto — the shelf would render fields the run drops. Add a zod \`inputSchema\` to the entry step (see SAP-2226).`,
    ];
  }
  if (schema.keys === null) return []; // schema not a readable literal — skip.

  const errors = [];
  for (const s of settings) {
    if (typeof s?.path !== "string") continue;
    const root = s.path.split(".")[0];
    if (!schema.keys.has(root)) {
      errors.push(
        `entry-schema: ${where} settings path "${s.path}" is not declared by the entry \`inputSchema\` (has: ${listKeys(schema.keys)}). The shelf would render a field the run drops.`,
      );
    }
  }
  for (const key of defaultInput) {
    if (!schema.keys.has(key)) {
      errors.push(
        `entry-schema: ${where} defaultInput key "${key}" is not declared by the entry \`inputSchema\` (has: ${listKeys(schema.keys)}). A default that projects onto no field is dead data.`,
      );
    }
  }
  return errors;
}

function listKeys(keys) {
  return [...keys].sort().join(", ") || "(none)";
}

function describeProjection(settings, defaultInput) {
  const parts = [];
  if (settings.length) parts.push(`${settings.length} setting(s)`);
  if (defaultInput.length) parts.push("a defaultInput");
  return parts.join(" and ");
}
