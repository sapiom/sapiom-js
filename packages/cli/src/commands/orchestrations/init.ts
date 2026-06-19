import path from 'node:path';

import { OrchestrationError, scaffold } from '@sapiom/orchestration-core';

import { CliError, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations init [dir]` — scaffold a new orchestration project.
 * Non-interactive by design (agent-friendly): everything comes from argv.
 */
export async function runInit(dir: string | undefined, opts: { template: string }): Promise<void> {
  if (!dir) {
    throw new CliError({
      code: 'MISSING_DIR',
      message: 'A target directory is required.',
      hint: 'Usage: sapiom orchestrations init <dir>',
    });
  }

  const targetDir = path.resolve(dir);

  try {
    await scaffold({ targetDir, template: opts.template });
  } catch (err) {
    if (err instanceof OrchestrationError) throw new CliError(err.toStructured());
    throw err;
  }

  ok({ dir, path: targetDir }, [
    '',
    `✓ Created ${dir}`,
    '',
    'Next steps:',
    `  cd ${dir}`,
    '  npm install',
    '  npm run check      # validate your orchestration locally',
    "  # edit index.ts — your orchestration is defined with defineOrchestration({ steps })",
    "  # Sapiom capabilities are available pre-auth'd on ctx.sapiom inside any step",
    '',
  ]);
}
