#!/usr/bin/env node
/**
 * `npm create @sapiom/agent <dir>` — scaffold a new Sapiom agent
 * project. Non-interactive by design (agent-friendly): everything comes from
 * argv, no prompts.
 *
 *   npm create @sapiom/agent my-agent
 *   npx @sapiom/create-agent my-agent --template default
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { scaffold } from './scaffold';
import { DEFAULT_TEMPLATE, listTemplates, resolveTemplate } from './templates';
import { resolveVersions } from './versions';

interface Args {
  dir?: string;
  template: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { template: DEFAULT_TEMPLATE, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--template' || a === '-t') args.template = argv[++i] ?? args.template;
    else if (!a.startsWith('-') && args.dir === undefined) args.dir = a;
  }
  return args;
}

function printHelp(): void {
  const templates = listTemplates();
  console.log(
    [
      'Create a new Sapiom agent project.',
      '',
      'Usage:',
      '  npm create @sapiom/agent <dir> [-- --template <name>]',
      '  npx @sapiom/create-agent <dir> [--template <name>]',
      '',
      'Options:',
      '  -t, --template <name>   Template to scaffold from' +
        (templates.length ? ` (${templates.join(', ')})` : '') +
        `. Default: ${DEFAULT_TEMPLATE}`,
      '  -h, --help              Show this help',
    ].join('\n'),
  );
}

function printNextSteps(dir: string): void {
  console.log(
    [
      '',
      `✓ Created ${dir}`,
      '',
      'Next steps:',
      `  cd ${dir}`,
      '  npm install',
      '  # edit index.ts — your agent is defined with defineAgent({ steps })',
      '  # Sapiom capabilities are available pre-auth\'d on ctx.sapiom inside any step',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dir) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const targetDir = path.resolve(args.dir);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    console.error(`Error: target directory '${args.dir}' already exists and is not empty.`);
    process.exit(1);
  }

  // Throws (clear message) on an unknown template — the resolver seam.
  const templateDir = resolveTemplate(args.template);
  const versions = await resolveVersions();

  mkdirSync(targetDir, { recursive: true });
  scaffold({
    templateDir,
    targetDir,
    replacements: {
      __PROJECT_NAME__: path.basename(targetDir),
      __AGENT_VERSION__: versions.agent,
      __TOOLS_VERSION__: versions.tools,
      __ZOD_VERSION__: versions.zod,
    },
  });

  printNextSteps(args.dir);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
