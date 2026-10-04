/**
 * Per-ticket timers. The controller has no cron: it runs for one ticket when that ticket next needs
 * something, from a one-shot schedule (`schedule_once`, input `{ issueId }`) set here.
 *
 * After every agent changes a ticket, it calls {@link rescheduleIssue}. That works out the ticket's
 * next due time from the controller's own rules (`agents/controller/rules.ts`): the next nudge
 * round, the next escalation level, and for an On Hold ticket the next Linear check
 * (`linear-check.ts`). It then replaces the ticket's stored schedule with one at that time, or
 * cancels it when nothing is due (a closed ticket, or every rule already sent its last round).
 *
 * A ticket handled in time costs no controller run; a late one costs a run when a nudge, an
 * escalation level or a Linear check comes due.
 *
 * Duplicate or late ticks are harmless: a tick rechecks every condition against the database and
 * dedups through `nudges`, so a stray schedule (one a concurrent reschedule left behind, or one
 * whose cancel failed) costs one run and sends nothing twice.
 *
 * Schedules go through `@sapiom/tools` `schedules` on the run's own credential, or a client on
 * `ctx.sapiom.schedules` (tests inject a fake there). On a local trace nothing is sent: the call
 * logs and stores a `local:` id, as the Slack helpers do.
 */
import type { AgentExecutionContext } from "@sapiom/agent";
import { schedules as toolsSchedules } from "@sapiom/tools";

import {
  escalationTimes,
  nudgeRounds,
  type DraftRow,
  type IssueRow,
  type MessageRow,
  type SentRow,
} from "../agents/controller/rules";
import { escalations, getConfigOr, type DeskEscalation } from "./config";
import type { Db, Row } from "./db";
import { listDesks, oncallFor, type Desk } from "./desks";
import { agentSlug } from "./fleet-id";
import {
  getIssue,
  setNextTick,
  type Direction,
  type DraftStatus,
  type Issue,
  type IssueStatus,
} from "./issues";
import { linearCheckDue } from "./linear-check";

/** The agent every ticket timer starts. */
export const CONTROLLER = agentSlug("controller");

/** A schedule is never set closer than this, so it cannot be in the past when it reaches the engine. */
export const MIN_LEAD_MS = 30_000;
/**
 * After a tick, something still due means it cannot be sent now (no desk, or a Slack error the run
 * survived); the next try waits this long rather than looping.
 */
export const STUCK_RETRY_MINUTES = 60;
/**
 * A tick arms this retry before it sends, so a run that fails partway does not leave the ticket
 * with no timer. The tick's last step replaces it.
 */
export const TICK_RETRY_MINUTES = 30;

export type SchedulesApi = Pick<typeof toolsSchedules, "create" | "cancel">;

export type TimerCtx = Pick<
  AgentExecutionContext<Record<string, unknown>>,
  "isLocalTrace" | "logger"
> & { sapiom?: unknown };

function api(ctx: TimerCtx): SchedulesApi {
  const fromCtx = (ctx.sapiom as { schedules?: SchedulesApi } | undefined)
    ?.schedules;
  return fromCtx ?? toolsSchedules;
}

let localSeq = 0;

async function createTick(
  ctx: TimerCtx,
  issueId: string,
  at: Date,
): Promise<string> {
  if (ctx.isLocalTrace) {
    ctx.logger.info("schedules create (local trace, not sent)", {
      issueId,
      at: at.toISOString(),
    });
    return `local:${++localSeq}`;
  }
  const made = await api(ctx).create({
    definition: CONTROLLER,
    kind: "schedule_once",
    at: at.toISOString(),
    input: { issueId },
  });
  return made.id;
}

/** A schedule that already fired, or was cancelled, may refuse a cancel; neither is a failure. */
async function cancelTick(ctx: TimerCtx, id: string): Promise<void> {
  if (ctx.isLocalTrace || id.startsWith("local:")) {
    ctx.logger.info("schedules cancel (local trace, not sent)", { id });
    return;
  }
  try {
    await api(ctx).cancel(id);
  } catch (err) {
    ctx.logger.warn("schedule not cancelled; a stray tick sends nothing", {
      id,
      err: String(err),
    });
  }
}

// --- what is due -----------------------------------------------------------------------------

export interface Snapshot {
  issues: IssueRow[];
  drafts: DraftRow[];
  messages: MessageRow[];
  sent: SentRow[];
  now: Date;
}

const OPEN = "i.status <> 'closed'";

/**
 * Everything the rules need for the open issues (or for one), plus the database's clock. With
 * `lock`, the issue rows are locked (`for update`), so a status change waits for the caller's
 * transaction.
 */
export async function snapshot(
  db: Db,
  issueId?: string,
  opts: { lock?: boolean } = {},
): Promise<Snapshot> {
  const where = issueId ? `${OPEN} and i.id = $1` : OPEN;
  const params = issueId ? [issueId] : [];
  const [issues, drafts, messages, sent, clock] = [
    await db.query(
      `select i.id, i.status, i.owner_slack_id, i.triage_root_ts, i.desk_id, i.priority, i.created_at from issues i where ${where}${opts.lock ? " for update" : ""}`,
      params,
    ),
    await db.query(
      `select d.id, d.issue_id, d.status, d.created_at from drafts d join issues i on i.id = d.issue_id where ${where}`,
      params,
    ),
    await db.query(
      `select m.id, m.issue_id, m.direction, m.text, m.ts, m.created_at from messages m join issues i on i.id = m.issue_id where ${where}`,
      params,
    ),
    await db.query(
      `select n.issue_id, n.kind, n.sent_at from nudges n join issues i on i.id = n.issue_id where ${where}`,
      params,
    ),
    await db.query<{ now: Date }>("select now() as now"),
  ];
  return {
    issues: issues.map((r: Row) => ({
      id: r.id as string,
      status: r.status as IssueStatus,
      ownerSlackId: (r.owner_slack_id as string | null) ?? null,
      triageRootTs: (r.triage_root_ts as string | null) ?? null,
      deskId: (r.desk_id as string | null) ?? null,
      priority: (r.priority as string | null) ?? null,
      createdAt: new Date(r.created_at as Date),
    })),
    drafts: drafts.map((r: Row) => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      status: r.status as DraftStatus,
      createdAt: new Date(r.created_at as Date),
    })),
    messages: messages.map((r: Row) => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      direction: r.direction as Direction,
      text: (r.text as string | null) ?? null,
      ts: (r.ts as string | null) ?? null,
      createdAt: new Date(r.created_at as Date),
    })),
    sent: sent.map((r: Row) => ({
      issueId: r.issue_id as string,
      kind: r.kind as string,
      sentAt: new Date(r.sent_at as Date),
    })),
    // The database clock, so a laptop or sandbox with drift cannot move a threshold.
    now: new Date(clock[0].now),
  };
}

/** Share threshold loading so the tick, its send and the timer apply the same configuration precedence. */
export async function thresholds(db: Db) {
  return {
    sla: await getConfigOr(db, "sla", null),
    minutes: await getConfigOr(db, "nudge.minutes", 30),
    repeatMinutes: await getConfigOr(db, "nudge.repeat_minutes", [60, 240]),
    deskMinutes: Object.fromEntries(
      (await listDesks(db)).map((d) => [d.id, d.nudgeMinutes]),
    ),
  };
}

/** Config entries use desk slugs, while issue rows identify desks by ID. */
export async function escalationConfig(db: Db, desks: Desk[]) {
  const bySlug = await escalations(db);
  const entries: Record<string, DeskEscalation> = {};
  const unnotifiable = new Set<string>();
  for (const d of desks) {
    const entry = bySlug[d.slug];
    if (!entry) continue;
    entries[d.id] = entry;
    // Never recorded, so it would be due again every run: keep it away from Jev, send and timers.
    if (!entry.groupId && !entry.oncallSlackId && !(await oncallFor(db, d)))
      unnotifiable.add(d.id);
  }
  return {
    entries,
    unnotifiable,
    levels: Object.fromEntries(
      Object.entries(entries).map(([id, e]) => [id, e.levels]),
    ),
    defaultDeskId: desks.find((d) => d.isDefault)?.id ?? null,
  };
}

export type DueReason = "nudge" | "escalation" | "linear_check";

export interface NextDue {
  dueAt: Date;
  reason: DueReason;
  /** The nudge key or escalation level that comes due, for the logs. */
  detail: string;
}

/**
 * When the open issue next needs the controller, or null when nothing will come due on its own
 * (closed, or every rule has sent its last round). Reads with the Jev check on, as a tick does:
 * a message Jev said needs no reply is not waited on.
 */
export async function nextDue(
  db: Db,
  issue: Issue,
  opts: { lock?: boolean } = {},
): Promise<NextDue | null> {
  if (issue.status === "closed") return null;
  const snap = await snapshot(db, issue.id, opts);
  const candidates: NextDue[] = [];
  for (const n of nudgeRounds({ ...snap, ...(await thresholds(db)) }))
    candidates.push({ dueAt: n.dueAt, reason: "nudge", detail: n.key });
  const esc = await escalationConfig(db, await listDesks(db));
  for (const e of escalationTimes({ ...snap, ...esc }, esc.unnotifiable))
    candidates.push({
      dueAt: e.dueAt,
      reason: "escalation",
      detail: "next level",
    });
  const check = linearCheckDue(issue);
  if (check)
    candidates.push({
      dueAt: check,
      reason: "linear_check",
      detail: issue.linearIdentifier ?? "",
    });
  return candidates.reduce<NextDue | null>(
    (best, c) => (!best || c.dueAt.getTime() < best.dueAt.getTime() ? c : best),
    null,
  );
}

// --- the schedule ----------------------------------------------------------------------------

export interface Reschedule {
  issueId: string;
  /** The schedule now stored, or null when the issue has none. */
  tickId: string | null;
  at: Date | null;
  due: NextDue | null;
  /** False when the stored schedule already fired at the right time and was kept. */
  changed: boolean;
  paused?: true;
}

/**
 * Set the issue's one controller schedule to its next due time; cancel it when nothing is due.
 *
 * Idempotent: a stored schedule at the same time is kept. A due time already past (the ticket was
 * left overdue, as when a run failed before it rescheduled) is set {@link MIN_LEAD_MS} ahead;
 * from a tick (`tick: true`) it is set {@link STUCK_RETRY_MINUTES} ahead, since the tick just
 * tried and could not send it. `at` overrides the computed time (the tick's retry guard).
 *
 * The decision and the stored id share a transaction holding the issue row lock, so two agents
 * rescheduling one ticket at once agree on one schedule. The old schedule is cancelled after the
 * commit; a cancel that fails leaves a stray tick that sends nothing.
 *
 * Throws when the schedule cannot be created: the caller's step fails and retries, rather than
 * leaving a ticket that would never nudge. Call it outside any transaction.
 */
export async function rescheduleIssue(
  db: Db,
  ctx: TimerCtx,
  issueId: string,
  opts: { tick?: boolean; at?: Date } = {},
): Promise<Reschedule> {
  const paused = await getConfigOr(db, "controller.paused", false);
  const { result, cancel } = await db.transaction(async (tx) => {
    const rows = await tx.query(
      "select id from issues where id = $1 for update",
      [issueId],
    );
    const none = (due: NextDue | null = null) => ({
      result: { issueId, tickId: null, at: null, due, changed: false },
      cancel: null as string | null,
    });
    if (rows.length === 0) return none();
    const issue = await getIssue(tx, issueId);
    const due = paused ? null : await nextDue(tx, issue, { lock: true });
    const [{ now }] = await tx.query<{ now: Date }>("select now() as now");
    const nowMs = new Date(now).getTime();

    let at: Date | null = null;
    if (opts.at) at = opts.at;
    else if (due) {
      const floor = opts.tick
        ? nowMs + STUCK_RETRY_MINUTES * 60_000
        : nowMs + MIN_LEAD_MS;
      at =
        due.dueAt.getTime() > nowMs + MIN_LEAD_MS ? due.dueAt : new Date(floor);
    }

    if (!at) {
      if (!issue.nextTickId) return none(due);
      await setNextTick(tx, issueId, null, null);
      return {
        result: { issueId, tickId: null, at: null, due, changed: true },
        cancel: issue.nextTickId,
      };
    }
    // Same time, still ahead: the stored schedule already fires when it should.
    if (
      issue.nextTickId &&
      issue.nextTickAt &&
      new Date(issue.nextTickAt).getTime() === at.getTime() &&
      at.getTime() > nowMs
    )
      return {
        result: {
          issueId,
          tickId: issue.nextTickId,
          at,
          due,
          changed: false,
        },
        cancel: null,
      };
    const tickId = await createTick(ctx, issueId, at);
    await setNextTick(tx, issueId, tickId, at);
    return {
      result: { issueId, tickId, at, due, changed: true },
      cancel: issue.nextTickId,
    };
  });
  if (cancel) await cancelTick(ctx, cancel);
  ctx.logger.info("ticket timer", {
    issueId,
    at: result.at?.toISOString() ?? null,
    due: result.due
      ? { reason: result.due.reason, detail: result.due.detail }
      : null,
    changed: result.changed,
    ...(paused ? { paused: true } : {}),
  });
  return paused ? { ...result, paused: true } : result;
}

/**
 * Reschedule every open issue: the controller run with no `issueId` (the Console's Run now, and
 * the step after install or after the controller switch comes back on). Each issue is its own
 * transaction; one that fails is reported and the rest go on.
 */
export async function rescheduleOpen(
  db: Db,
  ctx: TimerCtx,
): Promise<{ armed: number; cleared: number; failed: string[] }> {
  const rows = await db.query<{ id: string }>(
    "select id from issues where status <> 'closed' or next_tick_id is not null order by number",
  );
  let armed = 0;
  let cleared = 0;
  const failed: string[] = [];
  for (const { id } of rows) {
    try {
      const r = await rescheduleIssue(db, ctx, id);
      if (r.tickId) armed++;
      else if (r.changed) cleared++;
    } catch (err) {
      ctx.logger.error("ticket timer not set", {
        issueId: id,
        err: String(err),
      });
      failed.push(id);
    }
  }
  return { armed, cleared, failed };
}
