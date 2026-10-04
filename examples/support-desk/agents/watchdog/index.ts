/**
 * watchdog: the failure alarm. Each failed run of a support desk agent (itself and the smoke
 * agents excluded) gets one Slack message: which agent and step, the attempt, the fault class, a
 * link to the run, and what to do about it.
 *
 * Trigger: the platform event `sapiom.run.failed` (fleet.json). The engine emits it for every run
 * in the org that ends failed, never for the watchdog's own runs, so the watchdog runs only when
 * something fails and needs no key. The event has no error text; the run page has it.
 *
 * Channel: `alerts.channel`, else the default desk's triage channel.
 *
 * State: `watchdog_alerts` holds every failure already posted, so a redelivered event or a retried
 * step does not post twice. A failure is posted, then recorded (post then record, a known
 * limitation).
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";

import { agentSlug } from "../../_shared/fleet-id";
import { getConfigOr } from "../../_shared/config";
import { defaultDesk, NoDeskError } from "../../_shared/desks";
import { withDb, type Db } from "../../_shared/db";
import { RunFailed } from "../../_shared/events";
import { post, type SlackCtx } from "../../_shared/slack";

import {
  describeFailure,
  failureKey,
  failureMessage,
  isWatched,
} from "./logic";

export const AGENT = agentSlug("watchdog");

/** Posted rows older than this are dropped; a redelivery arrives within minutes. */
const KEEP_ALERTS_DAYS = 30;

/** The issue the run worked on, from the `runs` table every agent writes first. */
async function issueNumberOf(
  db: Db,
  executionId: string,
): Promise<number | null> {
  const rows = await db.query<{ number: number }>(
    "select i.number from runs r join issues i on i.id = r.issue_id where r.execution_id = $1",
    [executionId],
  );
  return rows[0]?.number ?? null;
}

async function alertChannel(db: Db): Promise<string> {
  const channel =
    (await getConfigOr(db, "alerts.channel", null)) ??
    (await defaultDesk(db))?.triageChannel ??
    (await getConfigOr(db, "channels.triage", null));
  if (!channel) throw new NoDeskError("the alert channel");
  return channel;
}

/** Report one failure. Exported so tests run it against an in-memory database. */
export async function report(ctx: SlackCtx, db: Db, event: RunFailed) {
  if (!isWatched(event.slug))
    return { outcome: "not_this_fleet", slug: event.slug };
  const key = failureKey(event);
  const seen = await db.query(
    "select 1 from watchdog_alerts where failure_key = $1",
    [key],
  );
  if (seen.length > 0)
    return { outcome: "already_reported", executionId: event.executionId };

  const channel = await alertChannel(db);
  const msg = failureMessage(
    describeFailure(event, await issueNumberOf(db, event.executionId)),
  );
  await post(ctx, { channel, text: msg.text, blocks: msg.blocks });
  await db.query(
    "insert into watchdog_alerts (failure_key, execution_id, agent) values ($1, $2, $3) on conflict do nothing",
    [key, event.executionId, event.slug],
  );
  await db.query(
    `delete from watchdog_alerts where posted_at < now() - interval '${KEEP_ALERTS_DAYS} days'`,
  );
  return {
    outcome: "posted",
    channel,
    executionId: event.executionId,
    agent: event.slug,
  };
}

const notify = defineStep({
  name: "notify",
  terminal: true,
  inputSchema: RunFailed,
  async run(input, ctx) {
    // Another fleet's failure needs no database, so it costs no connection.
    if (!isWatched(input.slug))
      return terminate({ outcome: "not_this_fleet", slug: input.slug });
    return terminate(await withDb(ctx, (db) => report(ctx, db, input)));
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Support desk watchdog: on sapiom.run.failed, posts each failed support desk run to Slack with the failed step, the fault class and what to do.",
  entry: "notify",
  steps: { notify },
});
