import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertValidGraph,
  buildManifest,
  isOrchestrationDefinition,
  workflowManifestSchema,
} from '@sapiom/orchestration';
import * as esbuild from 'esbuild';

import { CliError, isJsonMode, ok } from '../../lib/output.js';

// The authoritative SDK version is stamped by the server build; locally we
// record a placeholder so `check` stays a fast, dependency-light pre-flight.
const LOCAL_SDK_VERSION = '0.0.0-local';

/**
 * `sapiom orchestrations check [dir]` — validate an orchestration locally:
 * bundle index.ts, load it, derive the manifest, and check the step graph.
 * Offline and zero-cost; mirrors what the server build validates.
 */
export async function runCheck(dir: string | undefined): Promise<void> {
  const sourceDir = path.resolve(dir ?? process.cwd());
  const entryFile = path.join(sourceDir, 'index.ts');
  if (!existsSync(entryFile)) {
    throw new CliError({
      code: 'NO_ENTRY',
      message: `No index.ts found in ${sourceDir}.`,
      hint: 'Run this from an orchestration project, or pass its directory.',
    });
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'sapiom-check-'));
  const bundlePath = path.join(tmp, 'definition.mjs');
  try {
    try {
      await esbuild.build({
        entryPoints: [entryFile],
        outfile: bundlePath,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        logLevel: 'silent',
      });
    } catch (err) {
      throw new CliError({
        code: 'BUNDLE_FAILED',
        message: 'Failed to bundle the orchestration.',
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    // The brand survives bundling (Symbol.for keyed in the global registry), so
    // the imported definition is recognized even though it was bundled with the
    // project's own copy of the SDK.
    const mod: Record<string, unknown> = await import(`file://${bundlePath}?t=${Date.now()}`);
    const defs: unknown[] = [];
    for (const value of Object.values(mod)) {
      if (isOrchestrationDefinition(value) && !defs.includes(value)) defs.push(value);
    }

    if (defs.length === 0) {
      throw new CliError({
        code: 'NO_DEFINITION',
        message: 'No orchestration was exported from index.ts.',
        hint: 'Export the result of defineOrchestration({ … }).',
      });
    }
    if (defs.length > 1) {
      throw new CliError({
        code: 'MULTIPLE_DEFINITIONS',
        message: 'index.ts exports more than one orchestration.',
        hint: 'Export exactly one defineOrchestration({ … }) result.',
      });
    }

    const def = defs[0] as Parameters<typeof buildManifest>[0];
    const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');

    let manifest;
    try {
      manifest = workflowManifestSchema.parse(
        buildManifest(def, { sdkVersion: LOCAL_SDK_VERSION, artifact: { sha256, entryFile: 'definition.mjs' } }),
      );
    } catch (err) {
      throw new CliError({
        code: 'MANIFEST_INVALID',
        message: 'The orchestration produced an invalid manifest.',
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    let warnings: string[] = [];
    try {
      warnings = assertValidGraph(manifest);
    } catch (err) {
      throw new CliError({
        code: 'GRAPH_INVALID',
        message: 'The orchestration graph is invalid.',
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    const steps = (manifest as { steps?: unknown }).steps;
    const stepCount = Array.isArray(steps) ? steps.length : Object.keys(steps ?? {}).length;
    const name = (manifest as { name?: string }).name ?? 'orchestration';

    if (isJsonMode()) {
      ok({ name, steps: stepCount, warnings, manifest });
    } else {
      ok({}, [`✓ ${name} — ${stepCount} step(s), graph OK`, ...warnings.map((w) => `  ⚠ ${w}`)]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
