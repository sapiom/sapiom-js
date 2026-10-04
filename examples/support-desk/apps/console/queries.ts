/**
 * The desk-scoped reads behind the Console's board, ticket and account drawers, metrics and
 * failed-events views. Plain SQL, kept apart from `server.ts` (which starts a listener on import)
 * so the scoping can be tested on pg-mem. Every query here takes the selected desk's id; none
 * returns another desk's issues.
 */
import type { Db } from "../../_shared/db";

export async function statusCounts(
  d: Db,
  deskId: string,
): Promise<Record<string, number>> {
  const rows = await d.query<{ status: string; n: string }>(
    "select status, count(*) as n from issues where desk_id = $1 group by status",
    [deskId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/** The board's statuses: open is every status but closed. */
export const BOARD_FILTERS = [
  "open",
  "new",
  "on_you",
  "on_customer",
  "on_hold",
  "closed",
] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

export function parseBoardFilter(raw: string | null): BoardFilter | null {
  if (raw === null || raw === "") return "open";
  return (BOARD_FILTERS as readonly string[]).includes(raw)
    ? (raw as BoardFilter)
    : null;
}

/** Board rows at most; the open queue of a working desk is far shorter. */
export const BOARD_LIMIT = 200;

export interface BoardRow {
  id: string;
  number: number;
  accountId: string;
  account: string;
  title: string | null;
  status: string;
  priority: string | null;
  ownerSlackId: string | null;
  linearIdentifier: string | null;
  linearUrl: string | null;
  /** The Linear state linear-sync last read (`issues.linear_state`); null until its first check. */
  linearState: string | null;
  /** The newest draft's status; null when the copilot has drafted nothing. */
  draftStatus: string | null;
  triageRootTs: string | null;
  /** The channel holding the card: the one stored with it (082), else the desk's. */
  triageChannel: string;
  createdAt: Date;
}

const toBoardRow = (r: Record<string, unknown>): BoardRow => ({
  id: r.id as string,
  number: Number(r.number),
  accountId: r.account_id as string,
  account: r.account as string,
  title: (r.title as string | null) ?? null,
  status: r.status as string,
  priority: (r.priority as string | null) ?? null,
  ownerSlackId: (r.owner_slack_id as string | null) ?? null,
  linearIdentifier: (r.linear_identifier as string | null) ?? null,
  linearUrl: (r.linear_url as string | null) ?? null,
  linearState: (r.linear_state as string | null) ?? null,
  draftStatus: null,
  triageRootTs: (r.triage_root_ts as string | null) ?? null,
  triageChannel: r.triage_channel as string,
  createdAt: r.created_at as Date,
});

const ISSUE_COLUMNS = `i.id, i.number, i.account_id, a.name as account, i.title, i.status, i.priority,
  i.owner_slack_id, i.linear_identifier, i.linear_url, i.linear_state, i.triage_root_ts, coalesce(i.triage_channel, d.triage_channel) as triage_channel, i.created_at`;

/** Each row's newest draft status, read in one query rather than per row. */
async function withDraftStatus(d: Db, rows: BoardRow[]): Promise<BoardRow[]> {
  if (!rows.length) return rows;
  const drafts = await d.query<{ issue_id: string; status: string }>(
    "select issue_id, status from drafts where issue_id = any($1) order by created_at desc",
    [rows.map((r) => r.id)],
  );
  const newest = new Map<string, string>();
  for (const row of drafts)
    if (!newest.has(row.issue_id)) newest.set(row.issue_id, row.status);
  return rows.map((r) => ({ ...r, draftStatus: newest.get(r.id) ?? null }));
}

/** The desk's issues in `filter`, newest first. */
export async function boardIssues(
  d: Db,
  deskId: string,
  filter: BoardFilter = "open",
  limit = BOARD_LIMIT,
): Promise<BoardRow[]> {
  const rows = await d.query<Record<string, unknown>>(
    `select ${ISSUE_COLUMNS}
       from issues i join accounts a on a.id = i.account_id join desks d on d.id = i.desk_id
      where i.desk_id = $1 and ${filter === "open" ? "i.status <> 'closed'" : "i.status = $2"}
      order by i.number desc limit ${Math.trunc(limit)}`,
    filter === "open" ? [deskId] : [deskId, filter],
  );
  return withDraftStatus(d, rows.map(toBoardRow));
}

export interface TicketView extends BoardRow {
  /** The newest pending draft: its text, and the card its buttons sit on. */
  pendingDraft: {
    id: string;
    text: string;
    cardChannel: string | null;
    cardTs: string | null;
  } | null;
}

/** One issue of the desk with its pending draft; null for an id on another desk or none. */
export async function deskTicket(
  d: Db,
  deskId: string,
  issueId: string,
): Promise<TicketView | null> {
  const rows = await d.query<Record<string, unknown>>(
    `select ${ISSUE_COLUMNS}
       from issues i join accounts a on a.id = i.account_id join desks d on d.id = i.desk_id
      where i.desk_id = $1 and i.id = $2`,
    [deskId, issueId],
  );
  if (!rows[0]) return null;
  const [row] = await withDraftStatus(d, [toBoardRow(rows[0])]);
  const [pending] = await d.query<Record<string, unknown>>(
    "select id, text, card_channel, card_ts from drafts where issue_id = $1 and status = 'pending' order by created_at desc limit 1",
    [issueId],
  );
  return {
    ...row!,
    pendingDraft: pending
      ? {
          id: pending.id as string,
          text: pending.text as string,
          cardChannel: (pending.card_channel as string | null) ?? null,
          cardTs: (pending.card_ts as string | null) ?? null,
        }
      : null,
  };
}

/** Tickets an account drawer lists, newest first. */
export const ACCOUNT_TICKETS = 50;

export interface AccountView {
  id: string;
  name: string;
  channelId: string;
  open: number;
  closedLast30Days: number;
  /** The newest customer message on any of its issues. */
  lastContactAt: Date | null;
  tickets: {
    id: string;
    number: number;
    title: string | null;
    status: string;
    createdAt: Date;
  }[];
}

/** An account of the desk, with its counts and newest tickets; null for one on another desk. */
export async function deskAccount(
  d: Db,
  deskId: string,
  accountId: string,
  now: number = Date.now(),
): Promise<AccountView | null> {
  const [account] = await d.query<Record<string, unknown>>(
    "select id, name, slack_channel_id from accounts where id = $1 and desk_id = $2",
    [accountId, deskId],
  );
  if (!account) return null;
  const since = new Date(now - 30 * 24 * 3600_000).toISOString();
  const [counts, [contact], tickets] = await Promise.all([
    d.query<{ open: string; closed: string }>(
      `select coalesce(sum(case when status <> 'closed' then 1 else 0 end), 0) as open,
              coalesce(sum(case when status = 'closed' and closed_at >= $2 then 1 else 0 end), 0) as closed
         from issues where account_id = $1`,
      [accountId, since],
    ),
    d.query<{ at: Date | null }>(
      `select max(m.created_at) as at from messages m join issues i on i.id = m.issue_id
        where i.account_id = $1 and m.direction = 'customer'`,
      [accountId],
    ),
    d.query<Record<string, unknown>>(
      `select id, number, title, status, created_at from issues where account_id = $1
        order by number desc limit ${ACCOUNT_TICKETS}`,
      [accountId],
    ),
  ]);
  return {
    id: account.id as string,
    name: account.name as string,
    channelId: account.slack_channel_id as string,
    open: Number(counts[0]?.open ?? 0),
    closedLast30Days: Number(counts[0]?.closed ?? 0),
    lastContactAt: contact?.at ?? null,
    tickets: tickets.map((t) => ({
      id: t.id as string,
      number: Number(t.number),
      title: (t.title as string | null) ?? null,
      status: t.status as string,
      createdAt: t.created_at as Date,
    })),
  };
}

/**
 * Slack users who have worked the desk: ticket owners, draft deciders, and the authors of its
 * non-customer messages. The connector cannot list a channel's members (`conversations.members` is
 * not a method it allows), so these stand in for the triage channel's membership.
 */
export async function deskPeople(d: Db, deskId: string): Promise<string[]> {
  const [owners, deciders, authors] = await Promise.all([
    d.query<{ id: string }>(
      "select distinct owner_slack_id as id from issues where desk_id = $1 and owner_slack_id is not null",
      [deskId],
    ),
    d.query<{ id: string }>(
      `select distinct dr.decided_by as id from drafts dr join issues i on i.id = dr.issue_id
        where i.desk_id = $1 and dr.decided_by is not null`,
      [deskId],
    ),
    d.query<{ id: string }>(
      `select distinct m.user_id as id from messages m join issues i on i.id = m.issue_id
        where i.desk_id = $1 and m.direction <> 'customer' and m.user_id is not null`,
      [deskId],
    ),
  ]);
  return [...new Set([...owners, ...deciders, ...authors].map((r) => r.id))];
}

/** The desk's issues created since `since`, newest first. */
export function metricIssues(
  d: Db,
  deskId: string,
  since: number,
  limit: number,
) {
  return d.query<Record<string, unknown>>(
    `select id, number, created_at, triage_root_ts from issues
      where desk_id = $1 and created_at >= $2 order by number desc limit ${Math.trunc(limit)}`,
    [deskId, new Date(since).toISOString()],
  );
}

/** Which desk each receipt's issue belongs to; a receipt that names no issue is absent. */
export async function receiptDesks(
  d: Db,
  receiptIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (!receiptIds.length) return new Map();
  const rows = await d.query<{ receipt_id: string; desk_id: string | null }>(
    `select e.receipt_id, i.desk_id
       from events_log e join issues i on i.id::text = e.payload->>'issueId'
      where e.receipt_id = any($1)`,
    [[...receiptIds]],
  );
  return new Map(rows.map((r) => [r.receipt_id, r.desk_id]));
}
