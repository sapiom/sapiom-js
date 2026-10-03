/**
 * SAP-3788 adds opt-in escalation so stalled issues can reach a person beyond triage.
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
import { escapeMrkdwn, nudge, slackToPlain } from "../../_shared/blocks";
import {
  escalations,
  getConfigOr,
  type DeskEscalation,
} from "../../_shared/config";
import { withDb, type Db, type Row } from "../../_shared/db";
import { listDesks, oncallFor, type Desk } from "../../_shared/desks";
import { emit } from "../../_shared/emit";
import {
  getIssue,
  recordNudge,
  recordRun,
  type Direction,
  type DraftStatus,
  type IssueStatus,
} from "../../_shared/issues";
import { permalink, post } from "../../_shared/slack";

import {
  byThreadOrder,
  dueEscalations,
  dueNudges,
  ESCALATION_KINDS,
  NUDGE_KINDS,
  nudgeKey,
  skipKey,
  type Escalation,
  type DraftRow,
  type IssueRow,
  type MessageRow,
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
const EscalationSchema = z.object({
  issueId: z.string(),
  deskId: z.string(),
  level: z.number().int().positive(),
  reasons: z.array(
    z.object({
      kind: z.enum(ESCALATION_KINDS),
      refId: z.string(),
      minutes: z.number(),
    }),
  ),
  key: z.string(),
});
const SendInput = z.object({
  nudges: z.array(NudgeSchema),
  escalations: z.array(EscalationSchema).optional(),
});

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

/** Config entries use desk slugs, while issue rows identify desks by ID. */
async function escalationConfig(db: Db, desks: Desk[]) {
  const bySlug = await escalations(db);
  const entries: Record<string, DeskEscalation> = {};
  const unnotifiable = new Set<string>();
  for (const d of desks) {
    const entry = bySlug[d.slug];
    if (!entry) continue;
    entries[d.id] = entry;
    // Never recorded, so it would be due again every run: keep it away from Jev and send.
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

const REASON_TEXT: Record<Escalation["reasons"][number]["kind"], string> = {
  no_owner: "no owner",
  customer_waiting: "customer waiting for a reply",
};

const reasonsText = (e: Escalation) =>
  e.reasons
    .map((r) => `${REASON_TEXT[r.kind]} for ${r.minutes} min`)
    .join(", ");

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
      const esc = await escalationConfig(db, await listDesks(db));
      const escalate = (sent: Snapshot["sent"]) =>
        dueEscalations({ ...snap, sent, ...esc, jevCheck });
      const notifiable = (e: Escalation) => !esc.unnotifiable.has(e.deskId);

      // The customer messages to ask Jev about: one question per message, shared by a nudge and
      // an escalation that wait on the same message.
      const waiting = new Map<string, string>();
      if (jevCheck) {
        for (const n of candidates)
          if (n.kind === "customer_waiting") waiting.set(n.refId, n.issueId);
        for (const e of escalate(snap.sent).filter(notifiable))
          for (const r of e.reasons)
            if (r.kind === "customer_waiting") waiting.set(r.refId, e.issueId);
      }
      const noReply = new Set<string>();
      const skipped: { issueId: string; key: string; expectsReply: number }[] =
        [];
      for (const [msgId, issueId] of waiting) {
        const thread = snap.messages
          .filter((m) => m.issueId === issueId && m.direction !== "internal")
          .sort(byThreadOrder);
        let p: number;
        try {
          p = await expectsReply(ctx, thread);
        } catch (err) {
          // A spare nudge costs less than a forgotten customer, so a Jev failure nudges.
          ctx.logger.warn("jev check failed; nudging", {
            issueId,
            err: String(err),
          });
          continue;
        }
        if (p < EXPECTS_REPLY_MIN) {
          // Remember the verdict for this message, so the next run neither nudges nor asks again.
          await recordNudge(db, issueId, skipKey("customer_waiting", msgId));
          noReply.add(msgId);
          skipped.push({
            issueId,
            key: nudgeKey("customer_waiting", msgId),
            expectsReply: p,
          });
        }
      }
      const nudges = candidates.filter(
        (n) => !(n.kind === "customer_waiting" && noReply.has(n.refId)),
      );
      // Rerun with the new verdicts, so a rejected message drops its reason and the escalation
      // stands only on a condition that still holds long enough.
      const all = escalate([
        ...snap.sent,
        ...skipped.map((s) => ({
          issueId: s.issueId,
          kind: `skip:${s.key}`,
        })),
      ]);
      const due = all.filter(notifiable);
      const unnotified = all.filter((e) => !notifiable(e)).map((e) => e.key);
      ctx.logger.info("controller scan", {
        openIssues: snap.issues.length,
        due: candidates.length,
        nudges: nudges.length,
        escalations: due.length,
        unnotified,
        skipped,
      });
      if (nudges.length === 0 && due.length === 0)
        return terminate({
          nudged: [],
          escalated: [],
          unnotified,
          skipped,
          jevCheck,
        });
      return goto("send", {
        nudges,
        escalations: due,
        unnotified,
        skipped,
        jevCheck,
      });
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
    unnotified: z.array(z.string()).optional(),
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

      const esc = await escalationConfig(db, desks);
      const escalated: {
        issueId: string;
        key: string;
        dmTs: string | null;
        threadTs: string;
      }[] = [];
      const unnotified = [...(input.unnotified ?? [])];
      for (const e of input.escalations ?? []) {
        const out = await db.transaction(async (tx) => {
          // Recheck under the issue lock to prevent stale conditions or racing higher levels from paging.
          // Honor Jev skip verdicts unless jevCheck is disabled.
          const fresh = await snapshot(tx, e.issueId);
          const due = dueEscalations({
            ...fresh,
            ...esc,
            jevCheck: input.jevCheck ?? true,
          }).find((d) => d.key === e.key);
          const issue = await getIssue(tx, e.issueId);
          if (!due || !issue.triageRootTs) return "resolved" as const;
          const desk = desks.find((d) => d.id === issue.deskId) ?? fallbackDesk;
          const entry = desk && esc.entries[desk.id];
          if (!desk || !entry) return "resolved" as const;
          const oncall = entry.oncallSlackId ?? (await oncallFor(tx, desk));
          if (!oncall && !entry.groupId) return "unnotified" as const;
          if (!(await recordNudge(tx, e.issueId, e.key))) return null;
          const why = reasonsText(due);
          const link = permalink(desk.triageChannel, issue.triageRootTs);
          const title = escapeMrkdwn(issue.title ?? "(untitled)");
          const dm = oncall
            ? await post(ctx, {
                channel: oncall,
                text: `Escalation (level ${due.level}) on #${issue.number} ${title}: ${why}. <${link}|Open the triage thread>`,
              })
            : null;
          const who = entry.groupId
            ? `<!subteam^${entry.groupId}>`
            : `<@${oncall}>`;
          const thread = await post(ctx, {
            channel: desk.triageChannel,
            threadTs: issue.triageRootTs,
            text: `${who} escalation (level ${due.level}) on #${issue.number}: ${why}.`,
          });
          return { dmTs: dm?.ts ?? null, threadTs: thread.ts };
        });
        if (out === "unnotified") {
          ctx.logger.warn("escalation has nobody to notify", {
            issueId: e.issueId,
            key: e.key,
          });
          unnotified.push(e.key);
        } else if (out === "resolved") resolved.push(e.key);
        else if (out)
          escalated.push({ issueId: e.issueId, key: e.key, ...out });
        else notSent.push(e.key);
      }
      return terminate({
        nudged,
        escalated,
        unnotified,
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
    "Support desk controller: a cron that pings the triage thread once per stale condition (no owner, no draft, draft pending, customer waiting), and escalates to on-call and a support group when an issue stays unowned or a customer keeps waiting past a desk's escalation levels.",
  entry: "scan",
  steps: { scan, send },
});
