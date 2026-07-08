/**
 * check — local typecheck + bundle + manifest + graph validation. No network
 * required; the offline pre-flight before deploy. The typecheck step is what
 * catches type errors and references to capabilities that don't exist (which
 * the bundle, being type-stripped, cannot).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertValidGraph, buildManifest, isAgentDefinition, agentManifestSchema } from '@sapiom/agent';
import * as esbuild from 'esbuild';

import { AgentOperationError } from './errors.js';

/**
 * Run the project's TypeScript compiler in no-emit mode. Returns a warning
 * string if typecheck was skipped (TypeScript not installed), or null on
 * success. Throws `TYPECHECK_FAILED` with the compiler output on type errors.
 */
function runTypecheck(sourceDir: string): string | null {
  const tscBin = path.join(sourceDir, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tscBin)) {
    return 'typecheck skipped — TypeScript is not installed (run npm install first)';
  }
  try {
    execFileSync(tscBin, ['--noEmit'], { cwd: sourceDir, stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const output = (e.stdout?.toString() ?? '').trim() || (e.stderr?.toString() ?? '').trim();
    throw new AgentOperationError({
      code: 'TYPECHECK_FAILED',
      message: 'The agent has type errors.',
      hint: output || 'Run `tsc --noEmit` for details.',
    });
  }
}

// The authoritative SDK version is stamped by the server build; locally we
// record a placeholder so `check` stays a fast, dependency-light pre-flight.
const LOCAL_SDK_VERSION = '0.0.0-local';

export interface CheckOptions {
  /** Absolute path to the agent project directory containing index.ts. */
  sourceDir: string;
}

export interface CheckResult {
  name: string;
  stepCount: number;
  warnings: string[];
  /** The fully-validated manifest, returned for callers that want the raw shape. */
  manifest: unknown;
}

/**
 * Validate an agent locally: bundle index.ts with esbuild, load it,
 * derive and Zod-parse the manifest, and check the step graph.
 *
 * Throws `AgentOperationError` on any validation failure (codes:
 * `NO_ENTRY` | `TYPECHECK_FAILED` | `BUNDLE_FAILED` | `NO_DEFINITION` |
 * `MULTIPLE_DEFINITIONS` | `MANIFEST_INVALID` | `GRAPH_INVALID`).
 */
export async function check(opts: CheckOptions): Promise<CheckResult> {
  const { sourceDir } = opts;
  const entryFile = path.join(sourceDir, 'index.ts');

  if (!existsSync(entryFile)) {
    throw new AgentOperationError({
      code: 'NO_ENTRY',
      message: `No index.ts found in ${sourceDir}.`,
      hint: 'Run this from an agent project, or pass its directory.',
    });
  }

  // Typecheck first — it's the only step that validates types and capability
  // references (the bundle is type-stripped). Throws TYPECHECK_FAILED on errors.
  const warnings: string[] = [];
  const typecheckSkip = runTypecheck(sourceDir);
  if (typecheckSkip) warnings.push(typecheckSkip);

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
      throw new AgentOperationError({
        code: 'BUNDLE_FAILED',
        message: 'Failed to bundle the agent.',
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    // The brand survives bundling (Symbol.for keyed in the global registry), so
    // the imported definition is recognized even though it was bundled with the
    // project's own copy of the SDK.
    const mod: Record<string, unknown> = await import(`file://${bundlePath}?t=${Date.now()}`);
    const defs: unknown[] = [];
    for (const value of Object.values(mod)) {
      if (isAgentDefinition(value) && !defs.includes(value)) defs.push(value);
    }

    if (defs.length === 0) {
      throw new AgentOperationError({
        code: 'NO_DEFINITION',
        message: 'No agent was exported from index.ts.',
        hint: 'Export the result of defineAgent({ … }).',
      });
    }
    if (defs.length > 1) {
      throw new AgentOperationError({
        code: 'MULTIPLE_DEFINITIONS',
        message: 'index.ts exports more than one agent.',
        hint: 'Export exactly one defineAgent({ … }) result.',
      });
    }

    const def = defs[0] as Parameters<typeof buildManifest>[0];
    const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');

    let manifest: unknown;
    try {
      manifest = agentManifestSchema.parse(
        buildManifest(def, { sdkVersion: LOCAL_SDK_VERSION, artifact: { sha256, entryFile: 'definition.mjs' } }),
      );
    } catch (err) {
      throw new AgentOperationError({
        code: 'MANIFEST_INVALID',
        message: 'The agent produced an invalid manifest.',
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      warnings.push(...assertValidGraph(manifest as Parameters<typeof assertValidGraph>[0]));
    } catch (err) {
      throw new AgentOperationError({
        code: 'GRAPH_INVALID',
        message: 'The agent graph is invalid.',
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    const steps = (manifest as { steps?: unknown }).steps;
    const stepCount = Array.isArray(steps) ? steps.length : Object.keys(steps ?? {}).length;
    const name = (manifest as { name?: string }).name ?? 'agent';

    return { name, stepCount, warnings, manifest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
