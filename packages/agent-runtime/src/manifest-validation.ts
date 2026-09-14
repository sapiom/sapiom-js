import { normalizeInputJsonSchema, StepInputValidationError } from '@sapiom/agent';
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
 *
 * The schema is normalized first, by the same `normalizeInputJsonSchema` the
 * manifest generator applies, for two reasons. It keeps this pre-gate from
 * being stricter than the Zod parse it fronts: `additionalProperties: false`
 * would reject fields an upstream layer adds that the author does not control,
 * even though the parse downstream strips unknown keys rather than rejecting
 * them. And it repairs a manifest that was BUILT before the generator was
 * fixed — a stored manifest from an older SDK still lists a nested defaulted
 * field as required (SAP-3218), so normalizing on the way in makes a partial
 * input work with no redeploy. (A `.prefault()` field still needs one: output
 * mode emitted no `default` keyword for it, so there is nothing here to key
 * off.)
 */
export function validateManifestStepInput(
  stepName: string,
  schema: Record<string, unknown> | null,
  input: unknown,
): void {
  if (!schema) {
    return;
  }

  const validate = ajv.compile(normalizeInputJsonSchema(schema));
  const valid = validate(input);
  if (!valid) {
    const issues = mapAjvErrors(validate.errors ?? []);
    throw new StepInputValidationError(stepName, issues);
  }
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
