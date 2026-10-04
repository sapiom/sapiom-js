/**
 * Keep query helpers apart from server.ts so desk scoping can be tested without starting a
 * listener.
 */
import { z } from "zod/v4";

import {
  ConfigSchemas,
  deleteConfig,
  getConfigOr,
  setConfig,
} from "../../_shared/config";
import type { Db } from "../../_shared/db";
import type { Sla } from "../../_shared/sla";

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

export function recentIssues(d: Db, deskId: string, limit = 20) {
  return d.query<Record<string, unknown>>(
    `select i.id, i.number, a.name as account, i.title, i.status, i.priority, i.owner_slack_id,
            i.linear_identifier, i.triage_root_ts, i.created_at
       from issues i join accounts a on a.id = i.account_id
      where i.desk_id = $1
      order by i.number desc limit ${Math.trunc(limit)}`,
    [deskId],
  );
}

/** The desk's newest issue, or its issue `number`; an issue of another desk is not found. */
export async function deskIssue(
  d: Db,
  deskId: string,
  number?: number,
): Promise<Record<string, unknown> | undefined> {
  const rows = await d.query<Record<string, unknown>>(
    number === undefined
      ? "select * from issues where desk_id = $1 order by number desc limit 1"
      : "select * from issues where desk_id = $1 and number = $2",
    number === undefined ? [deskId] : [deskId, number],
  );
  return rows[0];
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

/** The customer-thread messages of the board's issues, for their SLA clocks. */
export async function issueMessages(d: Db, issueIds: readonly string[]) {
  if (!issueIds.length) return [];
  return d.query<{
    issue_id: string;
    direction: string;
    ts: string | null;
    created_at: Date;
  }>(
    `select issue_id, direction, ts, created_at from messages
      where issue_id = any($1) and direction <> 'internal'`,
    [[...issueIds]],
  );
}

// Attribute saved settings to the Console so their origin remains identifiable.
export const SLA_EDITOR = "console";

export const readSla = (d: Db): Promise<Sla | null> =>
  getConfigOr(d, "sla", null);

// Reject invalid settings before writing so a bad edit preserves the configured SLA.
export async function saveSla(
  d: Db,
  body: unknown,
): Promise<{ ok: true; sla: Sla } | { ok: false; error: string }> {
  const parsed = ConfigSchemas.sla.safeParse(body);
  if (!parsed.success)
    return { ok: false, error: z.prettifyError(parsed.error) };
  await setConfig(d, "sla", parsed.data, SLA_EDITOR);
  return { ok: true, sla: parsed.data };
}

export const clearSla = (d: Db): Promise<void> => deleteConfig(d, "sla");
