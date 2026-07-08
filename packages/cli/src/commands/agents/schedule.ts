/**
 * `sapiom agents schedule …` — manage schedules (cron + one-off triggers) for a
 * server-side orchestration, addressed by its slug. Thin wrappers over @sapiom/agent-core.
 */
import {
  cancelSchedule,
  createSchedule,
  getSchedule,
  listSchedules,
  AgentOperationError,
  parseJsonInput,
  previewCron,
  type ScheduleKind,
  type ScheduleStatus,
} from '@sapiom/agent-core';

import { type CliTarget, makeClient } from '../../lib/client.js';
import { readConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

interface HostOpts {
  host?: string;
  target?: CliTarget;
}

/** A client scoped to the project's host (if linked) with per-invocation flag overrides. */
function clientFor(opts: HostOpts) {
  return makeClient({ projectHost: readConfig(process.cwd())?.host, flagHost: opts.host, flagTarget: opts.target });
}

function rethrow(err: unknown): never {
  if (err instanceof AgentOperationError) throw new CliError(err.toStructured());
  throw err;
}

export async function runScheduleCreate(
  definition: string,
  opts: HostOpts & {
    cron?: string;
    timezone?: string;
    at?: string;
    input?: string;
    startAt?: string;
    endAt?: string;
  },
): Promise<void> {
  try {
    // `--at` ⇒ one-off; otherwise recurring (the engine validates the kind's required field).
    const kind: ScheduleKind = opts.at ? 'schedule_once' : 'schedule_cron';
    const schedule = await createSchedule(
      {
        definition,
        kind,
        cron: opts.cron,
        timezone: opts.timezone,
        at: opts.at,
        startAt: opts.startAt,
        endAt: opts.endAt,
        input: opts.input ? parseJsonInput(opts.input) : undefined,
      },
      clientFor(opts),
    );
    ok({ schedule }, [
      `✓ Created schedule ${schedule.id}${schedule.nextFireAt ? ` — next fire ${schedule.nextFireAt}` : ''}`,
      `  inspect: sapiom agents schedule inspect ${schedule.id}`,
    ]);
  } catch (err) {
    rethrow(err);
  }
}

export async function runScheduleList(definition: string, opts: HostOpts & { status?: string }): Promise<void> {
  try {
    const rows = await listSchedules(
      { definition, status: opts.status as ScheduleStatus | undefined },
      clientFor(opts),
    );
    ok({ schedules: rows }, [
      `${rows.length} schedule(s) for ${definition}`,
      ...rows.map((r) => `  ${r.id}  ${r.kind}  ${r.status}  ${r.cron ?? ''}  next:${r.nextFireAt ?? '—'}`),
    ]);
  } catch (err) {
    rethrow(err);
  }
}

export async function runScheduleInspect(scheduleId: string, opts: HostOpts): Promise<void> {
  try {
    const s = await getSchedule(scheduleId, clientFor(opts));
    ok({ schedule: s }, [
      `Schedule ${s.id}  (${s.kind}, ${s.status})`,
      `  next fire: ${s.nextFireAt ?? '—'}`,
      `  recent fires: ${s.recentFires.length}`,
    ]);
  } catch (err) {
    rethrow(err);
  }
}

export async function runScheduleCancel(scheduleId: string, opts: HostOpts): Promise<void> {
  try {
    const result = await cancelSchedule(scheduleId, clientFor(opts));
    ok({ id: result.id, status: result.status }, [`✓ Cancelled schedule ${scheduleId}`]);
  } catch (err) {
    rethrow(err);
  }
}

export async function runSchedulePreview(
  cron: string,
  opts: HostOpts & { timezone?: string; count?: string },
): Promise<void> {
  try {
    const result = await previewCron(
      { cron, timezone: opts.timezone, count: opts.count ? Number(opts.count) : undefined },
      clientFor(opts),
    );
    ok({ cron: result.cron, timezone: result.timezone, occurrences: result.occurrences }, [
      `Next ${result.occurrences.length} occurrence(s) of '${cron}' (${result.timezone}):`,
      ...result.occurrences.map((o) => `  ${o}`),
    ]);
  } catch (err) {
    rethrow(err);
  }
}
