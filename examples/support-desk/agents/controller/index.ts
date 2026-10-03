/**
 * controller: the follow-up cron. Every run reads the open issues, applies the rules in
 * `rules.ts`, and posts each due nudge once in the issue's triage thread: no owner, no draft, a
 * draft waiting for a decision, or a customer waiting for a reply.
 *
 * Trigger: `schedule_cron` (`*\/2 * * * *` in fleet.json). The trigger's stored `input` may carry
 * `jevCheck: false` to skip the Jev "does this expect a reply?" check on `customer_waiting`.
 */
import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

import { agentSlug } from "../../_shared/fleet-id";
import { nudge, slackToPlain } from "../../_shared/blocks";
import { getConfigOr } from "../../_shared/config";
import { withDb, type Db, type Row } from "../../_shared/db";
import { listDesks } from "../../_shared/desks";
import { emit } from "../../_shared/emit";
import {
  getIssue,
  recordNudge,
  recordRun,
  type Direction,
  type DraftStatus,
  type IssueStatus,
} from "../../_shared/issues";
import { post } from "../../_shared/slack";

import {
  byThreadOrder,
  dueNudges,
  NUDGE_KINDS,
  skipKey,
  type DraftRow,
  type IssueRow,
  type MessageRow,
  type Nudge,
} from "./rules";

export const AGENT = agentSlug("controller");

/** Below this Jev probability that the customer expects a reply, `customer_waiting` is skipped. */
export const EXPECTS_REPLY_MIN = 0.5;
/** How much of the customer thread Jev sees, newest last. */
const JEV_CONTEXT_MESSAGES = 6;

const Input = z.object({ jevCheck: z.boolean().optional() });

const NudgeSchema = z.object({
  issueId: z.string(),
  kind: z.enum(NUDGE_KINDS),
  refId: z.string(),
  key: z.string(),
});
const SendInput = z.object({ nudges: z.array(NudgeSchema) });

// --- reads (plain SQL; every write goes through _shared/issues.ts) ----------------------------

const OPEN = "i.status <> 'closed'";

interface Snapshot {
  issues: IssueRow[];
  drafts: DraftRow[];
  messages: MessageRow[];
  sent: { issueId: string; kind: string }[];
  now: Date;
}

/** Thresholds for `dueNudges`: each desk's own, and the pre-desk `nudge.minutes` for an issue with none. */
async function thresholds(db: Db) {
  return {
    minutes: await getConfigOr(db, "nudge.minutes", 30),
    deskMinutes: Object.fromEntries(
      (await listDesks(db)).map((d) => [d.id, d.nudgeMinutes]),
    ),
  };
}

/**
 * Everything the rules need for the open issues (or for one, inside `send`), plus the database's
 * clock. With `issueId`, the issue row is locked, so a status change waits for the nudge.
 */
export async function snapshot(db: Db, issueId?: string): Promise<Snapshot> {
  const where = issueId ? `${OPEN} and i.id = $1` : OPEN;
  const params = issueId ? [issueId] : [];
  const [issues, drafts, messages, sent, clock] = [
    await db.query(
      `select i.id, i.status, i.owner_slack_id, i.triage_root_ts, i.desk_id, i.created_at from issues i where ${where}${issueId ? " for update" : ""}`,
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
      `select n.issue_id, n.kind from nudges n join issues i on i.id = n.issue_id where ${where}`,
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
    })),
    // The database clock, so a laptop or sandbox with drift cannot move a threshold.
    now: new Date(clock[0].now),
  };
}

// --- steps -----------------------------------------------------------------------------------

type JevCtx = Pick<AgentExecutionContext<Record<string, unknown>>, "sapiom">;

/** Jev's probability that the customer's last message expects a reply from the team. */
async function expectsReply(
  ctx: JevCtx,
  thread: MessageRow[],
): Promise<number> {
  const recent = thread.slice(-JEV_CONTEXT_MESSAGES);
  const res = await ctx.sapiom.decisions.evaluate({
    state: {
      lastMessage: slackToPlain(recent[recent.length - 1]?.text ?? ""),
      thread: recent.map((m) => ({
        from: m.direction === "customer" ? "customer" : "support team",
        text: slackToPlain(m.text ?? ""),
      })),
    },
    questions: {
      expects_reply: {
        type: "noul",
        instructions:
          "Does the customer's last message (`lastMessage`) expect a reply from the support team? `thread` is the conversation so far, oldest first.",
        criteria: {
          true: "It asks a question, reports a problem, or requests something, so silence would leave the customer waiting.",
          false:
            "It thanks the team, confirms the problem is solved, or otherwise closes the conversation.",
        },
      },
    },
  });
  return res.answers.expects_reply.noul;
}

const scan = defineStep({
  name: "scan",
  next: ["send"],
  terminal: true,
  inputSchema: Input,
  async run(input, ctx) {
    const jevCheck = input.jevCheck ?? true;
    return withDb(ctx, async (db) => {
      await recordRun(db, ctx, AGENT);
      const snap = await snapshot(db);
      const candidates = dueNudges({
        ...snap,
        ...(await thresholds(db)),
        jevCheck,
      });

      const nudges: Nudge[] = [];
      const skipped: { issueId: string; key: string; expectsReply: number }[] =
        [];
      for (const n of candidates) {
        if (n.kind !== "customer_waiting" || !jevCheck) {
          nudges.push(n);
          continue;
        }
        const thread = snap.messages
          .filter((m) => m.issueId === n.issueId && m.direction !== "internal")
          .sort(byThreadOrder);
        let p: number;
        try {
          p = await expectsReply(ctx, thread);
        } catch (err) {
          // A spare nudge costs less than a forgotten customer, so a Jev failure nudges.
          ctx.logger.warn("jev check failed; nudging", {
            issueId: n.issueId,
            err: String(err),
          });
          nudges.push(n);
          continue;
        }
        if (p >= EXPECTS_REPLY_MIN) {
          nudges.push(n);
        } else {
          // Remember the verdict for this message, so the next run neither nudges nor asks again.
          await recordNudge(db, n.issueId, skipKey(n.kind, n.refId));
          skipped.push({ issueId: n.issueId, key: n.key, expectsReply: p });
        }
      }
      ctx.logger.info("controller scan", {
        openIssues: snap.issues.length,
        due: candidates.length,
        nudges: nudges.length,
        skipped,
      });
      if (nudges.length === 0)
        return terminate({ nudged: [], skipped, jevCheck });
      return goto("send", { nudges, skipped, jevCheck });
    });
  },
});

/**
 * Post and record each nudge in one transaction: lock the issue and recheck that the nudge is
 * still due on its current rows, insert the `nudges` row, post in the triage
 * thread, emit `issue.nudged`, commit. A failed post or emit rolls the row back, so the retry (or
 * the next cron run) sends it again: nothing is lost. A second run racing this one blocks on the
 * uncommitted row and then sees it, so it never posts the same nudge. The only duplicate is a
 * post that succeeded right before the emit or the commit failed.
 */
const send = defineStep({
  name: "send",
  terminal: true,
  inputSchema: SendInput.extend({
    skipped: z.array(z.unknown()).optional(),
    jevCheck: z.boolean().optional(),
  }),
  async run(input, ctx) {
    return withDb(ctx, async (db) => {
      const limits = await thresholds(db);
      const desks = await listDesks(db);
      const fallbackDesk = desks.find((d) => d.isDefault);
      const nudged: { issueId: string; key: string; ts: string }[] = [];
      const notSent: string[] = [];
      const resolved: string[] = [];
      for (const n of input.nudges) {
        const sent = await db.transaction(async (tx) => {
          // The issue may have moved since scan (taken, drafted, answered, held, closed): rerun the
          // rules on its current rows and post only if this nudge is still due. Jev already passed
          // this candidate in scan, so its skip records do not apply here.
          const fresh = await snapshot(tx, n.issueId);
          const stillDue = dueNudges({
            ...fresh,
            sent: [],
            ...limits,
            jevCheck: false,
          }).some((d) => d.key === n.key);
          const issue = await getIssue(tx, n.issueId);
          if (!stillDue || !issue.triageRootTs) return "resolved" as const;
          const desk = desks.find((d) => d.id === issue.deskId) ?? fallbackDesk;
          if (!desk) return "resolved" as const;
          const triage = desk.triageChannel;
          if (!(await recordNudge(tx, n.issueId, n.key))) return null;
          const card = await post(ctx, {
            channel: triage,
            threadTs: issue.triageRootTs,
            text: `Follow-up on #${issue.number}: ${n.kind.replace(/_/g, " ")}`,
            blocks: nudge(issue, n.kind, null, { triageChannel: triage }),
          });
          await emit(ctx, tx, "issue.nudged", {
            issueId: issue.id,
            accountId: issue.accountId,
            source: "slack",
            causationId: `nudge:${issue.id}:${n.key}`,
            slack: {
              channel: issue.customerChannel ?? triage,
              ts: issue.customerRootTs ?? issue.triageRootTs,
            },
            kind: n.kind,
          });
          return card.ts;
        });
        if (sent === "resolved") resolved.push(n.key);
        else if (sent)
          nudged.push({ issueId: n.issueId, key: n.key, ts: sent });
        else notSent.push(n.key);
      }
      return terminate({
        nudged,
        notSent,
        resolved,
        skipped: input.skipped ?? [],
        jevCheck: input.jevCheck ?? true,
      });
    });
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Support desk controller: a cron that pings the triage thread once per stale condition (no owner, no draft, draft pending, customer waiting).",
  entry: "scan",
  steps: { scan, send },
});
