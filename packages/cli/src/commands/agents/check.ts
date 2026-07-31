import path from 'node:path';

import { check, AgentOperationError } from '@sapiom/agent-core';

import { CliError, isJsonMode, ok } from '../../lib/output.js';

/** The minimal manifest shape {@link entryInputSchemaWarning} reads. */
export interface EntryContractManifest {
  entry: string;
  steps: Record<string, { inputSchema: Record<string, unknown> | null } | undefined>;
}

/**
 * The entry step's `inputSchema` is the agent's public input contract — the dashboard Run
 * form, the trigger snippet, and engine-side validation all read it. An entry step with no
 * schema publishes no contract: the dashboard then claims the agent takes no input. It is a
 * warning, not an error — an opaque agent stays legal — so `check` still exits 0.
 *
 * Returns the warning string (naming the entry step) or null when a schema is declared.
 */
export function entryInputSchemaWarning(manifest: EntryContractManifest): string | null {
  const entryStep = manifest.steps[manifest.entry];
  if (entryStep && entryStep.inputSchema === null) {
    return `entry step '${manifest.entry}' declares no inputSchema — the dashboard Run form, the trigger snippet, and engine validation all read it as the agent's public input contract. Declare one with zod (from 'zod/v4') so callers know what the agent takes.`;
  }
  return null;
}

/**
 * `sapiom agents check [dir]` — validate an agent locally:
 * bundle index.ts, load it, derive the manifest, and check the step graph.
 * Offline and zero-cost; mirrors what the server build validates.
 */
export async function runCheck(dir: string | undefined): Promise<void> {
  const sourceDir = path.resolve(dir ?? process.cwd());

  let result;
  try {
    result = await check({ sourceDir });
  } catch (err) {
    if (err instanceof AgentOperationError) {
      throw new CliError(err.toStructured());
    }
    throw err;
  }

  const { name, stepCount, warnings, manifest } = result;

  // The entry input contract is authoring guidance, not a graph defect, so it is surfaced
  // here at the CLI — not in the shared check() warnings, which the harness renders as
  // structural canvas notes. Warning only, so `check` still exits 0 (an opaque agent is legal).
  const entryWarning = entryInputSchemaWarning(manifest as EntryContractManifest);
  const allWarnings = entryWarning ? [...warnings, entryWarning] : warnings;

  if (isJsonMode()) {
    ok({ name, steps: stepCount, warnings: allWarnings, manifest });
  } else {
    ok({}, [`✓ ${name} — ${stepCount} step(s), graph OK`, ...allWarnings.map((w) => `  ⚠ ${w}`)]);
  }
}
