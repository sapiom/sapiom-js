import { Command } from 'commander';

import { action, json } from '../shared.js';
import { runCheck } from './check.js';
import { runDeploy } from './deploy.js';
import { runInit } from './init.js';
import { runLink } from './link.js';
import { runLogs } from './logs.js';
import { runRun } from './run.js';
import {
  runScheduleCancel,
  runScheduleCreate,
  runScheduleInspect,
  runScheduleList,
  runSchedulePreview,
} from './schedule.js';
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

/** Mount the `sapiom agents …` command group. */
export function registerAgentsCommands(program: Command): void {
  const group = program
    .command('agents')
    .alias('ag')
    .description('Author, validate, and ship Sapiom agents.');

  json(group.command('init [dir]').description('Scaffold a new agent project.'))
    .option('-t, --template <name>', 'template to scaffold from', 'default')
    .action(action(runInit));

  json(group.command('check [dir]').description('Validate an agent locally (bundle, manifest, graph).')).action(
    action(runCheck),
  );

  withHostFlags(json(group.command('link [name]').description('Link this project to its server-side agent.')))
    .option('--create', 'create the agent if it does not exist')
    .action(action(runLink));

  withHostFlags(
    json(group.command('deploy').description('Push the current commit, build, and wait for it to finish.')),
  ).option('-b, --branch <branch>', 'branch to push to', 'main').action(action(runDeploy));

  withHostFlags(json(group.command('run').description('Start an execution of the linked agent.')))
    .option('--input <json>', 'execution input as a JSON string')
    .option('--input-file <path>', 'read execution input from a JSON file')
    .action(action(runRun));

  withHostFlags(
    json(group.command('logs [executionId]').description('Inspect an execution, a build (--build), or recent runs.')),
  )
    .option('--build <buildRunId>', 'inspect a build instead of an execution')
    .option('-f, --follow', 'stream live updates and re-render until the run reaches a terminal status')
    .option('--watch', 'alias for --follow')
    .option('--verbose', 'show step errors, timings, and dispatch details')
    .action(action(runLogs));

  withHostFlags(json(group.command('signal <executionId>').description('Resume a paused execution.')))
    .requiredOption('--name <name>', 'the signal name to deliver')
    .requiredOption('--correlation-id <id>', 'the signal correlation id')
    .option('--payload <json>', 'signal payload as a JSON string')
    .action(action(runSignal));

  // `sapiom agents schedule …` — cron + one-off schedules for an agent (by slug).
  const schedule = group
    .command('schedule')
    .description('Manage schedules (cron + one-off triggers) for an agent.');

  withHostFlags(
    json(schedule.command('create <definition>').description('Create a cron (--cron) or one-off (--at) schedule.')),
  )
    .option('--cron <expr>', 'cron expression (recurring schedule)')
    .option('--timezone <tz>', 'IANA timezone for the cron (default UTC)')
    .option('--at <iso>', 'one-off fire time (ISO 8601)')
    .option('--input <json>', 'execution input as a JSON string')
    .option('--start-at <iso>', 'cron: earliest occurrence (ISO)')
    .option('--end-at <iso>', 'cron: latest occurrence (ISO)')
    .action(action(runScheduleCreate));

  withHostFlags(json(schedule.command('list <definition>').description("List an agent's schedules.")))
    .option('--status <status>', 'filter by status (active|paused|completed|disabled)')
    .action(action(runScheduleList));

  withHostFlags(
    json(schedule.command('inspect <scheduleId>').description('Show a schedule, its next fire, and recent fires.')),
  ).action(action(runScheduleInspect));

  withHostFlags(json(schedule.command('cancel <scheduleId>').description('Cancel a schedule.'))).action(
    action(runScheduleCancel),
  );

  withHostFlags(json(schedule.command('preview <cron>').description('Preview a cron expression (next occurrences).')))
    .option('--timezone <tz>', 'IANA timezone (default UTC)')
    .option('--count <n>', 'number of occurrences to show (default 5)')
    .action(action(runSchedulePreview));
}
