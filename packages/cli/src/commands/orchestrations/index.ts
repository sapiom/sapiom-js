import { Command } from 'commander';

import { action, json } from '../shared.js';
import { runCheck } from './check.js';
import { runDeploy } from './deploy.js';
import { runInit } from './init.js';
import { runLink } from './link.js';
import { runLogs } from './logs.js';
import { runRun } from './run.js';
import { runSignal } from './signal.js';

/**
 * Attach the shared --host / --target flags to a command. These override the
 * machine-level config and sapiom.json host for a single invocation.
 */
function withHostFlags(cmd: Command): Command {
  return cmd
    .option('--host <url>', 'API host URL (overrides config and SAPIOM_HOST)')
    .option('--target <target>', 'target environment: prod (default) or local');
}

/** Mount the `sapiom orchestrations …` command group. */
export function registerOrchestrationsCommands(program: Command): void {
  const group = program
    .command('orchestrations')
    .alias('orch')
    .description('Author, validate, and ship Sapiom orchestrations.');

  json(group.command('init [dir]').description('Scaffold a new orchestration project.'))
    .option('-t, --template <name>', 'template to scaffold from', 'default')
    .action(action(runInit));

  json(group.command('check [dir]').description('Validate an orchestration locally (bundle, manifest, graph).')).action(
    action(runCheck),
  );

  withHostFlags(json(group.command('link [name]').description('Link this project to its server-side orchestration.')))
    .option('--create', 'create the orchestration if it does not exist')
    .action(action(runLink));

  withHostFlags(
    json(group.command('deploy').description('Push the current commit, build, and wait for it to finish.')),
  ).option('-b, --branch <branch>', 'branch to push to', 'main').action(action(runDeploy));

  withHostFlags(json(group.command('run').description('Start an execution of the linked orchestration.')))
    .option('--input <json>', 'execution input as a JSON string')
    .option('--input-file <path>', 'read execution input from a JSON file')
    .action(action(runRun));

  withHostFlags(
    json(group.command('logs [executionId]').description('Inspect an execution, a build (--build), or recent runs.')),
  )
    .option('--build <buildRunId>', 'inspect a build instead of an execution')
    .action(action(runLogs));

  withHostFlags(json(group.command('signal <executionId>').description('Resume a paused execution.')))
    .requiredOption('--name <name>', 'the signal name to deliver')
    .requiredOption('--correlation-id <id>', 'the signal correlation id')
    .option('--payload <json>', 'signal payload as a JSON string')
    .action(action(runSignal));
}
