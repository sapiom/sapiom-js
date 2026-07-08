/**
 * Load an agent definition for local execution: bundle index.ts, import
 * it, find the single definition, and derive its manifest. Mirrors what `check`
 * does, but returns the live definition object (with runnable step bodies) so
 * the local dispatcher can execute steps in-process.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type AgentDefinition,
  type AgentManifest,
  buildManifest,
  isAgentDefinition,
  agentManifestSchema,
} from '@sapiom/agent';
import * as esbuild from 'esbuild';

import { AgentOperationError } from '../errors.js';

const LOCAL_SDK_VERSION = '0.0.0-local';

export interface LoadedDefinition {
  definition: AgentDefinition;
  manifest: AgentManifest;
}

/** Bundle + import + manifest a project directory's index.ts. */
export async function loadDefinition(sourceDir: string): Promise<LoadedDefinition> {
  const entryFile = path.join(sourceDir, 'index.ts');
  if (!existsSync(entryFile)) {
    throw new AgentOperationError({
      code: 'NO_ENTRY',
      message: `No index.ts found in ${sourceDir}.`,
      hint: 'Run this from an agent project, or pass its directory.',
    });
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'sapiom-run-'));
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

    const mod: Record<string, unknown> = await import(`file://${bundlePath}?t=${Date.now()}`);
    const defs = Object.values(mod).filter(isAgentDefinition);
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

    const definition = defs[0];
    const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
    const manifest = agentManifestSchema.parse(
      buildManifest(definition, { sdkVersion: LOCAL_SDK_VERSION, artifact: { sha256, entryFile: 'definition.mjs' } }),
    ) as AgentManifest;

    return { definition, manifest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
