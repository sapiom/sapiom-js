/**
 * Who a new issue goes to. Off unless `assign.auto` is on: then an issue nobody owns once intake has
 * opened it (Take, a teammate's answer and a customer's @mention all come first) goes to its
 * channel's `ownerSlackId` from `channels.customer`, else to the `team.members` entry for its desk
 * with the fewest open issues. The owner is who the card shows and who nudges mention, so each
 * person sees their own tickets instead of the on-call seeing all of them.
 */
import { customerChannel, getConfigFresh, type TeamMember } from "./config";
import type { Db } from "./db";
import { deskForIssue } from "./desks";
import { assign, getAccount, getIssue, lockIssue, type Issue } from "./issues";

/** The member with the fewest open issues; ties go to the one listed first. */
export function leastLoaded(
  members: readonly TeamMember[],
  openCounts: ReadonlyMap<string, number>,
): TeamMember | null {
  let best: TeamMember | null = null;
  for (const m of members)
    if (
      !best ||
      (openCounts.get(m.slackId) ?? 0) < (openCounts.get(best.slackId) ?? 0)
    )
      best = m;
  return best;
}

/** Members who take issues for desk `slug`: those with no `desks` list, and those listing it. */
export function membersFor(
  members: readonly TeamMember[],
  slug: string,
): TeamMember[] {
  return members.filter((m) => !m.desks?.length || m.desks.includes(slug));
}

async function openCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.query<{ owner: string; n: number | string }>(
    "select owner_slack_id as owner, count(*) as n from issues where status <> 'closed' and owner_slack_id is not null group by owner_slack_id",
  );
  return new Map(rows.map((r) => [String(r.owner), Number(r.n)]));
}

/**
 * The teammate issue `issue` would go to, or null when auto-assign is off, nobody fits, or it
 * already has an owner.
 */
export async function pickOwner(
  db: Db,
  issue: Issue,
): Promise<{ slackId: string; why: "channel owner" | "least loaded" } | null> {
  if (issue.ownerSlackId || issue.status === "closed") return null;
  if (!(await getConfigFresh(db, "assign.auto", false))) return null;
  const account = await getAccount(db, issue.accountId);
  const channelOwner = (await customerChannel(db, account.slackChannelId))
    ?.ownerSlackId;
  if (channelOwner) return { slackId: channelOwner, why: "channel owner" };
  const desk = await deskForIssue(db, issue);
  const pool = membersFor(
    await getConfigFresh(db, "team.members", []),
    desk.slug,
  );
  const pick = leastLoaded(pool, await openCounts(db));
  return pick ? { slackId: pick.slackId, why: "least loaded" } : null;
}

/**
 * Assign issue `issueId` per {@link pickOwner}, under the row lock so a Take landing at the same
 * moment keeps its owner. Returns the new owner, or null when nothing changed.
 */
export async function autoAssign(
  db: Db,
  issueId: string,
): Promise<string | null> {
  const pick = await pickOwner(db, await getIssue(db, issueId));
  if (!pick) return null;
  return db.transaction(async (tx) => {
    const locked = await lockIssue(tx, issueId);
    if (locked.ownerSlackId || locked.status === "closed") return null;
    await assign(tx, issueId, pick.slackId);
    return pick.slackId;
  });
}
