/**
 * Close every open issue, so a demo starts clean.
 *
 * Intake links a new top-level customer message to any open issue of the account that Jev judges
 * to be the same problem, so issues left open from a rehearsal would capture the demo's messages.
 * Each issue moves through `setStatus` (the status machine), and its triage card is redrawn from
 * the row so the channel shows it Closed. Linear issues are left as they are.
 */
import { issueCard, issueCardText } from "./blocks";
import type { Db } from "./db";
import { listDesks } from "./desks";
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

/**
 * Close every open issue and redraw its card in its stored channel, else its desk's triage
 * channel. With `deskId`, only that desk's issues. `dryRun` lists what would close and writes
 * nothing.
 */
export async function resetBoard(
  db: Db,
  ctx: SlackCtx,
  opts: { dryRun?: boolean; deskId?: string } = {},
): Promise<ResetOutcome[]> {
  const open = await db.query<{
    id: string;
    number: number;
    status: IssueStatus;
    title: string | null;
    desk_id: string | null;
  }>(
    `select id, number, status, title, desk_id from issues where status = any($1)${opts.deskId ? " and desk_id = $2" : ""} order by number`,
    opts.deskId ? [[...OPEN_STATUSES], opts.deskId] : [[...OPEN_STATUSES]],
  );
  if (!open.length) return [];
  const desks = await listDesks(db);
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
      // From the returned row, not the select above: reset-demo runs this without migrating, and a
      // database before 082_issue_triage_channel has no column to name.
      const triage =
        issue.triageChannel ??
        (
          desks.find((d) => d.id === row.desk_id) ??
          desks.find((d) => d.isDefault)
        )?.triageChannel;
      // A card that cannot be redrawn (no desk, deleted message) does not block the reset.
      card = triage
        ? await update(ctx, {
            channel: triage,
            ts: issue.triageRootTs,
            text: issueCardText(issue, account),
            blocks: issueCard(issue, account),
          }).then(
            () => "redrawn",
            (err: unknown) =>
              `not redrawn: ${err instanceof Error ? err.message : String(err)}`,
          )
        : "not redrawn: no desk";
    }
    out.push({ ...base, card });
  }
  return out;
}
