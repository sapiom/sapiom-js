import { createRequire } from 'node:module';
import path from 'node:path';

import { AgentOperationError, scaffold } from '@sapiom/orchestration-core';

import { CliError, ok } from '../../lib/output.js';

const nodeRequire = createRequire(import.meta.url);

/** Locate @sapiom/orchestration-core's bundled templates dir (no __dirname in ESM). */
function coreTemplatesDir(): string {
  const entry = nodeRequire.resolve('@sapiom/orchestration-core');
  return path.resolve(path.dirname(entry), '..', '..', 'templates');
}

/**
 * `sapiom agents init [dir]` — scaffold a new agent project.
 * Non-interactive by design (agent-friendly): everything comes from argv.
 */
export async function runInit(dir: string | undefined, opts: { template: string }): Promise<void> {
  if (!dir) {
    throw new CliError({
      code: 'MISSING_DIR',
      message: 'A target directory is required.',
      hint: 'Usage: sapiom agents init <dir>',
    });
  }

  const targetDir = path.resolve(dir);

  try {
    await scaffold({ targetDir, template: opts.template, templatesDir: coreTemplatesDir() });
  } catch (err) {
    if (err instanceof AgentOperationError) throw new CliError(err.toStructured());
    throw err;
  }

  ok({ dir, path: targetDir }, [
    '',
    `✓ Created ${dir}`,
    '',
    'Next steps:',
    `  cd ${dir}`,
    '  npm install',
    '  sapiom agents check      # validate your agent locally',
    "  # edit index.ts — your agent is defined with defineAgent({ steps })",
    "  # Sapiom capabilities are available pre-auth'd on ctx.sapiom inside any step",
    '',
  ]);
}
