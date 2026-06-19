import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { CliError, ok } from '../../lib/output.js';
import { scaffold } from '../../scaffold/scaffold.js';
import { resolveTemplate } from '../../scaffold/templates.js';
import { resolveVersions } from '../../scaffold/versions.js';

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
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new CliError({
      code: 'DIR_NOT_EMPTY',
      message: `Target directory '${dir}' already exists and is not empty.`,
    });
  }

  // Throws (clear message) on an unknown template — the resolver seam.
  const templateDir = resolveTemplate(opts.template);
  const versions = await resolveVersions();

  mkdirSync(targetDir, { recursive: true });
  scaffold({
    templateDir,
    targetDir,
    replacements: {
      __PROJECT_NAME__: path.basename(targetDir),
      __ORCHESTRATION_VERSION__: versions.orchestration,
      __TOOLS_VERSION__: versions.tools,
      __ZOD_VERSION__: versions.zod,
      __CLI_VERSION__: versions.cli,
    },
  });

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
