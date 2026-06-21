/**
 * Stub file model for local execution. A stub file supplies per-step capability
 * *overrides* for `run_local`; any capability call without an override uses the
 * built-in defaults from `@sapiom/tools/stub`, so a workflow runs locally with
 * no stubs at all and the author only overrides what a step's logic branches on.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "steps": {
 *       "<stepName>": { "<capability.path>": <response> | [<response>, ...] }
 *     }
 *   }
 *
 * Capability paths are namespace methods (`repositories.list`, `agent.coding.run`)
 * or handle methods (`repository.pushFromSandbox`, `sandbox.exec`). Scoped per
 * step so editing one step's overrides never affects another.
 */
import { OrchestrationError } from '../errors.js';

export const STUB_FILE_VERSION = 1;

/** A single canned response (any JSON value the capability would have returned). */
export type StubResponse = unknown;

/** One step's overrides: capability path → a single response or an ordered list. */
export type StepStubs = Record<string, StubResponse | StubResponse[]>;

/** The committed/agent-authored stub file. */
export interface StubFile {
  version: number;
  steps: Record<string, StepStubs>;
}

/**
 * Validate an untrusted (file/agent-supplied) value into a {@link StubFile}.
 * Throws `OrchestrationError` (code `STUBS_INVALID`) with an actionable message
 * on any structural problem.
 */
export function parseStubFile(raw: unknown): StubFile {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('the stub file must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  const version = obj.version ?? STUB_FILE_VERSION;
  if (typeof version !== 'number') {
    throw invalid('`version` must be a number.');
  }

  const stepsRaw = obj.steps ?? {};
  if (stepsRaw == null || typeof stepsRaw !== 'object' || Array.isArray(stepsRaw)) {
    throw invalid('`steps` must be an object keyed by step name.');
  }

  const steps: Record<string, StepStubs> = {};
  for (const [stepName, stepStubs] of Object.entries(stepsRaw as Record<string, unknown>)) {
    if (stepStubs == null || typeof stepStubs !== 'object' || Array.isArray(stepStubs)) {
      throw invalid(`steps.${stepName} must be an object keyed by capability path.`);
    }
    steps[stepName] = stepStubs as StepStubs;
  }

  return { version, steps };
}

function invalid(detail: string): OrchestrationError {
  return new OrchestrationError({
    code: 'STUBS_INVALID',
    message: `Invalid stub file: ${detail}`,
    hint: 'Expected { "version": 1, "steps": { "<step>": { "<capability.path>": <response> | [<response>] } } }.',
  });
}
