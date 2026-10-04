// Commit each desk/day claim with its post so retries skip committed claims.
// Slack delivery is not atomic with the database: ambiguous responses or failed commits can duplicate posts.
import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

import fleet from "../../fleet.json";

import { getConfigOr } from "../../_shared/config";
import { withDb, type Db, type Row } from "../../_shared/db";
import { listDesks, type Desk } from "../../_shared/desks";
import { agentSlug } from "../../_shared/fleet-id";
import {
  recordDigest,
  recordRun,
  type IssueStatus,
} from "../../_shared/issues";
import { post, userInfo, type SlackCtx } from "../../_shared/slack";

import {
  DEFAULT_SLA_HOURS,
  digestMessage,
  localDay,
  type DigestIssue,
} from "./logic";

export const AGENT = agentSlug("digest");

// A day is the schedule's local date, so a rerun in the evening still counts as that morning's digest.
export const TIME_ZONE =
  (fleet.triggers as { project: string; timezone?: string }[]).find(
    (t) => t.project === "digest",
  )?.timezone ?? "UTC";

type Ctx = SlackCtx & { executionId: string };

/** A desk's open issues; an issue with no desk belongs to the default desk, as `deskForIssue` says. */
async function openIssues(db: Db, desk: Desk): Promise<DigestIssue[]> {
  const rows = await db.query(
    `select i.number, i.status, i.priority, i.title, i.owner_slack_id, i.triage_root_ts, i.triage_channel, i.created_at, a.name as account_name
     from issues i join accounts a on a.id = i.account_id
     where i.status <> 'closed' and (i.desk_id = $1${desk.isDefault ? " or i.desk_id is null" : ""})`,
    [desk.id],
  );
  return rows.map((r: Row) => ({
    number: Number(r.number),
    status: r.status as IssueStatus,
    priority: (r.priority as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    accountName: r.account_name as string,
    ownerSlackId: (r.owner_slack_id as string | null) ?? null,
    triageRootTs: (r.triage_root_ts as string | null) ?? null,
    triageChannel: (r.triage_channel as string | null) ?? null,
    createdAt: new Date(r.created_at as Date),
  }));
}

/**
 * Post today's digest for every desk that has none yet. `now` defaults to the database clock, so a
 * sandbox with drift cannot move the day.
 */
export async function digest(ctx: Ctx, db: Db, now?: Date) {
  await recordRun(db, ctx, AGENT);
  const clock =
    now ??
    new Date((await db.query<{ now: Date }>("select now() as now"))[0].now);
  const day = localDay(clock, TIME_ZONE);
  const sla = {
    ...DEFAULT_SLA_HOURS,
    ...(await getConfigOr(db, "digest.sla_hours", {})),
  };

  const names = new Map<string, string>();
  const ownerName = async (id: string) => {
    if (!names.has(id))
      names.set(
        id,
        await userInfo(ctx, id).then(
          (u) => u.name,
          () => id,
        ),
      );
    return names.get(id)!;
  };

  const posted: string[] = [];
  const skipped: string[] = [];
  const failed: { desk: string; error: string }[] = [];
  for (const desk of await listDesks(db)) {
    try {
      const sent = await db.transaction(async (tx) => {
        if (!(await recordDigest(tx, desk.id, day))) return false;
        const issues = await openIssues(tx, desk);
        const owners = new Map<string, string>();
        for (const id of new Set(issues.map((i) => i.ownerSlackId)))
          if (id) owners.set(id, await ownerName(id));
        await post(ctx, {
          channel: desk.triageChannel,
          ...digestMessage({ desk, issues, owners, now: clock, day, sla }),
          key: `digest:${desk.id}:${day}`,
        });
        return true;
      });
      (sent ? posted : skipped).push(desk.slug);
    } catch (err) {
      failed.push({ desk: desk.slug, error: String(err) });
    }
  }
  ctx.logger.info("digest", { day, posted, skipped, failed });
  if (failed.length)
    throw new Error(
      `digest not posted for ${failed.map((f) => `${f.desk} (${f.error})`).join("; ")}; rerun the digest agent to post them`,
    );
  return { day, posted, skipped };
}

const postDigest = defineStep({
  name: "post",
  terminal: true,
  inputSchema: z.object({}).passthrough(),
  async run(_input, ctx) {
    return terminate(await withDb(ctx, (db) => digest(ctx, db)));
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Support desk digest: a daily cron that posts each desk's open issues, grouped by status with age, owner and SLA, in its triage channel.",
  entry: "post",
  steps: { post: postDigest },
});
