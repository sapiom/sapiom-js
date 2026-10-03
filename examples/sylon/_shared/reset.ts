/**
 * Close every open issue, so a demo starts clean.
 *
 * Intake links a new top-level customer message to any open issue of the account that Jev judges
 * to be the same problem, so issues left open from a rehearsal would capture the demo's messages.
 * Each issue moves through `setStatus` (the status machine), and its triage card is redrawn from
 * the row so the channel shows it Closed. Linear issues are left as they are.
 */
import { issueCard, issueCardText } from "./blocks";
import { getConfig } from "./config";
import type { Db } from "./db";
import { OPEN_STATUSES, getAccount, setStatus } from "./issues";
import type { IssueStatus } from "./issues";
import { update } from "./slack";
import type { SlackCtx } from "./slack";

export interface ResetOutcome {
  issueId: string;
  number: number;
  title: string | null;
  /** The status the issue had before the reset. */
  was: IssueStatus;
  /** `redrawn`, `no card`, `dry run`, or why the card could not be redrawn. */
  card: string;
}

/** Close every open issue and redraw its card. `dryRun` lists what would close and writes nothing. */
export async function resetBoard(
  db: Db,
  ctx: SlackCtx,
  opts: { dryRun?: boolean } = {},
): Promise<ResetOutcome[]> {
  const open = await db.query<{
    id: string;
    number: number;
    status: IssueStatus;
    title: string | null;
  }>(
    "select id, number, status, title from issues where status = any($1) order by number",
    [[...OPEN_STATUSES]],
  );
  if (!open.length) return [];
  const triage = await getConfig(db, "channels.triage");
  const out: ResetOutcome[] = [];
  for (const row of open) {
    const base = {
      issueId: row.id,
      number: Number(row.number),
      title: row.title,
      was: row.status,
    };
    if (opts.dryRun) {
      out.push({ ...base, card: "dry run" });
      continue;
    }
    const issue = await setStatus(db, row.id, "closed");
    let card = "no card";
    if (issue.triageRootTs) {
      const account = await getAccount(db, issue.accountId);
      // A card that cannot be redrawn (deleted message, other channel) does not block the reset.
      card = await update(ctx, {
        channel: triage,
        ts: issue.triageRootTs,
        text: issueCardText(issue, account),
        blocks: issueCard(issue, account),
      }).then(
        () => "redrawn",
        (err: unknown) =>
          `not redrawn: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    out.push({ ...base, card });
  }
  return out;
}
