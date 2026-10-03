/**
 * The only reader and writer of `desks`. A desk is one isolated support desk served by the shared
 * fleet: its own triage channel, Linear target, on-call user and nudge timing. Accounts, issues and
 * (optionally) knowledge articles belong to a desk; the agents are shared.
 *
 * Reads come from one per-Db cache of every desk (a fleet has a handful), so a run queries once.
 */
import { getConfigOr } from "./config";
import type { Db, Row } from "./db";

export interface Desk {
  id: string;
  slug: string;
  name: string;
  triageChannel: string;
  linearTeamId: string | null;
  linearProjectId: string | null;
  oncallSlackId: string | null;
  nudgeMinutes: number;
  isDefault: boolean;
  createdAt: Date;
}

export interface DeskInput {
  slug: string;
  name: string;
  triageChannel: string;
  linearTeamId?: string | null;
  linearProjectId?: string | null;
  oncallSlackId?: string | null;
  nudgeMinutes?: number;
  isDefault?: boolean;
}

export class NoDeskError extends Error {
  constructor(what: string) {
    super(
      `no desk for ${what}; add one under "desks" in fleet.local.json and run \`pnpm run setup\``,
    );
    this.name = "NoDeskError";
  }
}

const DEFAULT_NUDGE_MINUTES = 30;

const toDesk = (r: Row): Desk => ({
  id: r.id as string,
  slug: r.slug as string,
  name: r.name as string,
  triageChannel: r.triage_channel as string,
  linearTeamId: (r.linear_team_id as string | null) ?? null,
  linearProjectId: (r.linear_project_id as string | null) ?? null,
  oncallSlackId: (r.oncall_slack_id as string | null) ?? null,
  nudgeMinutes: Number(r.nudge_minutes),
  isDefault: r.is_default as boolean,
  createdAt: r.created_at as Date,
});

const cache = new WeakMap<Db, Promise<Desk[]>>();

/** Every desk, default first, then by slug. */
export async function listDesks(db: Db): Promise<Desk[]> {
  let desks = cache.get(db);
  if (!desks) {
    desks = db
      .query("select * from desks order by is_default desc, slug")
      .then((rows) => rows.map(toDesk));
    cache.set(db, desks);
    // A failed read is not cached: the next call retries.
    desks.catch(() => {
      if (cache.get(db) === desks) cache.delete(db);
    });
  }
  return desks;
}

export async function getDesk(db: Db, id: string): Promise<Desk> {
  const desk = (await listDesks(db)).find((d) => d.id === id);
  if (!desk) throw new Error(`desk ${id} not found`);
  return desk;
}

export async function deskBySlug(db: Db, slug: string): Promise<Desk | null> {
  return (await listDesks(db)).find((d) => d.slug === slug) ?? null;
}

/** The desk whose triage channel is `channel`, or null when it is not a triage channel. */
export async function deskByTriageChannel(
  db: Db,
  channel: string,
): Promise<Desk | null> {
  return (await listDesks(db)).find((d) => d.triageChannel === channel) ?? null;
}

export async function defaultDesk(db: Db): Promise<Desk | null> {
  return (await listDesks(db)).find((d) => d.isDefault) ?? null;
}

/** The default desk; throws {@link NoDeskError} on a database with none (setup has not run). */
export async function requireDefaultDesk(db: Db): Promise<Desk> {
  const desk = await defaultDesk(db);
  if (!desk) throw new NoDeskError("the default desk");
  return desk;
}

/**
 * Create the desk, or with `overwrite` update it to `input`. An existing desk is returned as it is
 * otherwise, so a setup rerun keeps what an onboarding flow changed. Marking a desk default
 * clears the flag on the others in the same transaction.
 */
export async function upsertDesk(
  db: Db,
  input: DeskInput,
  opts: { overwrite?: boolean } = {},
): Promise<{ desk: Desk; created: boolean; updated: boolean }> {
  const existing = await deskBySlug(db, input.slug);
  if (existing && !opts.overwrite)
    return { desk: existing, created: false, updated: false };
  await db.transaction(async (tx) => {
    if (input.isDefault)
      await tx.query(
        "update desks set is_default = false where is_default and slug <> $1",
        [input.slug],
      );
    if (existing) {
      await tx.query(
        `update desks set name = $2, triage_channel = $3, linear_team_id = $4, linear_project_id = $5,
           oncall_slack_id = $6, nudge_minutes = $7, is_default = $8 where id = $1`,
        [
          existing.id,
          input.name,
          input.triageChannel,
          input.linearTeamId ?? null,
          input.linearProjectId ?? null,
          input.oncallSlackId ?? null,
          input.nudgeMinutes ?? DEFAULT_NUDGE_MINUTES,
          input.isDefault ?? false,
        ],
      );
    } else {
      await tx.query(
        `insert into desks (slug, name, triage_channel, linear_team_id, linear_project_id, oncall_slack_id, nudge_minutes, is_default)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.slug,
          input.name,
          input.triageChannel,
          input.linearTeamId ?? null,
          input.linearProjectId ?? null,
          input.oncallSlackId ?? null,
          input.nudgeMinutes ?? DEFAULT_NUDGE_MINUTES,
          input.isDefault ?? false,
        ],
      );
    }
  });
  // Invalidate, never patch: the write may sit in a transaction that later rolls back.
  cache.delete(db);
  const desk = await deskBySlug(db, input.slug);
  if (!desk) throw new Error(`desk ${input.slug} not found after write`);
  return { desk, created: !existing, updated: Boolean(existing) };
}

/** The desk's Linear team and project, falling back to the pre-desk config keys; null when neither names one. */
export async function linearTarget(
  db: Db,
  desk: Desk,
): Promise<{ teamId: string; projectId: string } | null> {
  const teamId =
    desk.linearTeamId ?? (await getConfigOr(db, "linear.team_id", null));
  const projectId =
    desk.linearProjectId ?? (await getConfigOr(db, "linear.project_id", null));
  return teamId && projectId ? { teamId, projectId } : null;
}

/** The Slack user to page for the desk, falling back to the pre-desk `oncall.slack_id`. */
export async function oncallFor(db: Db, desk: Desk): Promise<string | null> {
  return desk.oncallSlackId ?? (await getConfigOr(db, "oncall.slack_id", null));
}

/**
 * The desk an issue belongs to. An issue without one (a row from before desks that the backfill
 * missed) belongs to the default desk.
 */
export async function deskForIssue(
  db: Db,
  issue: { deskId: string | null },
): Promise<Desk> {
  return issue.deskId ? getDesk(db, issue.deskId) : requireDefaultDesk(db);
}
