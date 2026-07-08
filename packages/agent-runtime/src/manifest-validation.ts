import { StepInputValidationError } from '@sapiom/agent';
// Explicit `.js` so the emitted ESM resolves under Node's strict ESM loader
// (the extensionless form only works for the CJS build).
import Ajv2020 from 'ajv/dist/2020.js';

/**
 * AJV-based manifest input validation — a cheap pre-gate before paying to run a
 * step. On failure it produces the same `StepInputValidationError` the Zod path
 * produces. Null schema → no validation (pass through).
 *
 * We use `ajv/dist/2020` (JSON Schema 2020-12) because `z.toJSONSchema()` emits
 * the 2020-12 meta-schema. `strict: false` avoids noise from keywords the
 * pre-gate doesn't enforce.
 */

const ajv = new Ajv2020({ strict: false, allErrors: true });

/**
 * Validate `input` against `schema`. Throws `StepInputValidationError` when
 * validation fails; returns void on success (no coercion — the authoritative
 * parse downstream does that). `schema = null` is a no-op.
 */
export function validateManifestStepInput(
  stepName: string,
  schema: Record<string, unknown> | null,
  input: unknown,
): void {
  if (!schema) {
    return;
  }

  const validate = ajv.compile(relaxAdditionalProperties(schema) as Record<string, unknown>);
  const valid = validate(input);
  if (!valid) {
    const issues = mapAjvErrors(validate.errors ?? []);
    throw new StepInputValidationError(stepName, issues);
  }
}

/**
 * Recursively strip `additionalProperties: false` from a JSON Schema.
 *
 * `z.toJSONSchema()` emits `additionalProperties: false` on every object, which
 * makes AJV reject any field the schema doesn't name — including additive
 * fields an upstream layer may add that the author has no control over. The
 * authoritative downstream Zod parse *strips* unknown keys rather than
 * rejecting, so a strict pre-gate would be stricter than the parse it fronts.
 * We relax the pre-gate to match: drop the `false` constraint wherever it
 * appears. A catchall (`additionalProperties: { type: ... }`) is left intact; a
 * property literally named `additionalProperties` is never `=== false`, so it's
 * never mis-stripped.
 */
function relaxAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(relaxAdditionalProperties);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'additionalProperties' && v === false) {
        continue;
      }
      out[key] = relaxAdditionalProperties(v);
    }
    return out;
  }
  return value;
}

/** Map AJV errors to the `$ZodIssueCustom`-compatible shape `StepInputValidationError` accepts. */
function mapAjvErrors(errors: NonNullable<InstanceType<typeof Ajv2020>['errors']>): Array<{
  readonly code: 'custom';
  readonly path: (string | number)[];
  readonly message: string;
  readonly input: unknown;
}> {
  return errors.map((err) => {
    const path = instancePathToArray(err.instancePath ?? '');
    if (err.keyword === 'required' && err.params && typeof err.params.missingProperty === 'string') {
      path.push(err.params.missingProperty);
    }
    return {
      code: 'custom' as const,
      path,
      message: err.message ?? 'validation error',
      input: undefined,
    };
  });
}

/** Convert a JSON Pointer (`/foo/bar/0`) to a path array (`['foo', 'bar', 0]`). */
function instancePathToArray(instancePath: string): (string | number)[] {
  if (!instancePath) return [];
  return instancePath
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const n = Number(segment);
      return Number.isInteger(n) && String(n) === segment ? n : segment;
    });
}
