/**
 * controller: runs for one ticket when its timer fires (`_shared/timers.ts`), sends whatever is due
 * on it, and sets its next timer. No cron: a ticket the team handles in time never starts a run.
 *
 * Trigger: the per-ticket `schedule_once` that `rescheduleIssue` keeps, input `{ issueId }`. Run
 * with no `issueId` (the Console's Run now, or by hand after install) it sends nothing and resets
 * every open ticket's timer.
 *
 * A tick:
 * 1. arms a retry timer ({@link TICK_RETRY_MINUTES}), so a run that fails partway still comes back;
 * 2. redraws the triage card if an earlier redraw failed;
 * 3. on an On Hold ticket whose Linear check is due, reads Linear (`_shared/linear-check.ts`), which
 *    moves it On You when the Linear issue is Done or Canceled;
 * 4. sends the due nudges (SAP-3787 repeat rounds; first-response and next-response targets when
 *    `sla` is set) and escalation levels (SAP-3788), each rechecked under the issue row lock and
 *    deduped through `nudges`, so a duplicate or late tick never sends twice;
 * 5. sets the next timer, or clears it when nothing more will come due.
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
import { getConfigFresh } from "../../_shared/config";
import { withDb } from "../../_shared/db";
import { listDesks, oncallFor } from "../../_shared/desks";
import { emit } from "../../_shared/emit";
import { getIssue, recordNudge, recordRun } from "../../_shared/issues";
import {
  checkLinear,
  linearCheckDue,
  redrawIfDirty,
  type LinearCheck,
} from "../../_shared/linear-check";
import { permalink, post } from "../../_shared/slack";
import {
  TICK_RETRY_MINUTES,
  escalationConfig,
  rescheduleIssue,
  rescheduleOpen,
  snapshot,
  thresholds,
  type Reschedule,
} from "../../_shared/timers";

import {
  byThreadOrder,
  dueEscalations,
  dueNudges,
  ESCALATION_KINDS,
  NUDGE_KINDS,
  skipKey,
  type Escalation,
  type EscalationInput,
  type MessageRow,
  type Nudge,
} from "./rules";

export const AGENT = agentSlug("controller");

/** Below this Jev probability that the customer expects a reply, `customer_waiting` is skipped. */
export const EXPECTS_REPLY_MIN = 0.5;
/** How much of the customer thread Jev sees, newest last. */
const JEV_CONTEXT_MESSAGES = 6;

/**
 * Cache successful Jev verdicts so repeat nudges avoid reevaluation.
 * Leave failures uncached so later due rounds can retry while Jev checking is enabled.
 */
const replyKey = (kind: Nudge["kind"], refId: string): string =>
  `reply:${kind}:${refId}`;

/**
 * `issueId`: the ticket whose timer fired; without it the run resets every open ticket's timer.
 * `jevCheck: false` nudges without asking Jev whether the customer expects a reply.
 */
const Input = z.object({
  issueId: z.string().uuid().optional(),
  jevCheck: z.boolean().optional(),
});

const NudgeSchema = z.object({
  issueId: z.string(),
  kind: z.enum(NUDGE_KINDS),
  refId: z.string(),
  n: z.number().int().positive(),
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
  issueId: z.string().uuid().optional(),
  nudges: z.array(NudgeSchema),
  escalations: z.array(EscalationSchema).optional(),
  linear: z.unknown().optional(),
});

const REASON_TEXT: Record<Escalation["reasons"][number]["kind"], string> = {
  no_owner: "no owner",
  customer_waiting: "customer waiting for a reply",
};

const reasonsText = (e: Escalation) =>
  e.reasons
    .map((r) => `${REASON_TEXT[r.kind]} for ${r.minutes} min`)
    .join(", ");

// --- steps -----------------------------------------------------------------------------------

/** The timer as a run's output shows it. */
const timerOut = (t: Reschedule) => ({
  issueId: t.issueId,
  at: t.at?.toISOString() ?? null,
  due: t.due ? { reason: t.due.reason, detail: t.due.detail } : null,
  changed: t.changed,
  ...(t.paused ? { paused: true } : {}),
});

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
      if (!input.issueId) {
        await recordRun(db, ctx, AGENT);
        const rearmed = await rescheduleOpen(db, ctx);
        ctx.logger.info("controller reset every open ticket's timer", rearmed);
        return terminate({ rearmed });
      }
      const issueId = input.issueId;
      await recordRun(db, ctx, AGENT, issueId);
      const exists = await db.query("select 1 from issues where id = $1", [
        issueId,
      ]);
      if (exists.length === 0)
        return terminate({ issueId, skipped: "issue not found" });
      let issue = await getIssue(db, issueId);
      // A paused controller, or a closed ticket: clear the timer and send nothing.
      if (
        issue.status === "closed" ||
        (await getConfigFresh(db, "controller.paused", false))
      ) {
        const timer = await rescheduleIssue(db, ctx, issueId);
        return terminate({
          issueId,
          skipped:
            issue.status === "closed" ? "issue is closed" : "controller paused",
          timer: timerOut(timer),
        });
      }
      const [{ now }] = await db.query<{ now: Date }>("select now() as now");
      const nowMs = new Date(now).getTime();
      // Replaced by the real next timer at the end; it stands only if this run fails before that.
      await rescheduleIssue(db, ctx, issueId, {
        at: new Date(nowMs + TICK_RETRY_MINUTES * 60_000),
      });
      await redrawIfDirty(ctx, db, issue);

      let linear: LinearCheck | null = null;
      const check = linearCheckDue(issue);
      if (check && check.getTime() <= nowMs) {
        linear = await checkLinear(ctx, db, issue, AGENT);
        issue = await getIssue(db, issueId);
      }

      const snap = await snapshot(db, issueId);
      const candidates = dueNudges({
        ...snap,
        ...(await thresholds(db)),
        jevCheck,
      });
      const esc = await escalationConfig(db, await listDesks(db));
      const escalate = (sent: EscalationInput["sent"]) =>
        dueEscalations({ ...snap, sent, ...esc, jevCheck });
      const notifiable = (e: Escalation) => !esc.unnotifiable.has(e.deskId);

      // The customer messages to ask Jev about: one question per message, shared by a nudge and
      // an escalation that wait on the same message.
      const waiting = new Map<string, string>();
      // A message Jev already said expects a reply is not asked about again.
      const answered = (issueId: string, msgId: string) =>
        snap.sent.some(
          (s) =>
            s.issueId === issueId &&
            s.kind === replyKey("customer_waiting", msgId),
        );
      if (jevCheck) {
        for (const n of candidates)
          if (n.kind === "customer_waiting" && !answered(n.issueId, n.refId))
            waiting.set(n.refId, n.issueId);
        for (const e of escalate(snap.sent).filter(notifiable))
          for (const r of e.reasons)
            if (r.kind === "customer_waiting" && !answered(e.issueId, r.refId))
              waiting.set(r.refId, e.issueId);
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
        if (p >= EXPECTS_REPLY_MIN) {
          // Remember the yes, so later rounds of this nudge do not ask Jev again.
          await recordNudge(db, issueId, replyKey("customer_waiting", msgId));
        } else {
          // Remember the verdict for this message, so the next run neither nudges nor asks again.
          await recordNudge(db, issueId, skipKey("customer_waiting", msgId));
          noReply.add(msgId);
          skipped.push({
            issueId,
            key: skipKey("customer_waiting", msgId),
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
          kind: s.key,
        })),
      ]);
      const due = all.filter(notifiable);
      const unnotified = all.filter((e) => !notifiable(e)).map((e) => e.key);
      ctx.logger.info("controller scan", {
        issueId,
        status: issue.status,
        due: candidates.length,
        nudges: nudges.length,
        escalations: due.length,
        unnotified,
        skipped,
      });
      if (nudges.length === 0 && due.length === 0) {
        const timer = await rescheduleIssue(db, ctx, issueId, { tick: true });
        return terminate({
          issueId,
          nudged: [],
          escalated: [],
          unnotified,
          skipped,
          jevCheck,
          linear,
          timer: timerOut(timer),
        });
      }
      return goto("send", {
        issueId,
        nudges,
        escalations: due,
        unnotified,
        skipped,
        jevCheck,
        linear,
      });
    });
  },
});

// Keep the nudge row and event log in one transaction so failures remain retryable.
// SAP-3721: the Slack marker survives rollback, allowing retries to adopt the earlier post.
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
      // Switched off since the scan: send nothing, and clear the timer as a paused scan would.
      if (await getConfigFresh(db, "controller.paused", false)) {
        const timer = input.issueId
          ? timerOut(await rescheduleIssue(db, ctx, input.issueId))
          : undefined;
        return terminate({
          ...(input.issueId ? { issueId: input.issueId } : {}),
          skipped: "controller paused",
          timer,
        });
      }
      const limits = await thresholds(db);
      const desks = await listDesks(db);
      const fallbackDesk = desks.find((d) => d.isDefault);
      const nudged: { issueId: string; key: string; ts: string }[] = [];
      const notSent: string[] = [];
      const resolved: string[] = [];
      for (const n of input.nudges) {
        const sent = await db.transaction(async (tx) => {
          // Recheck live conditions because scan may be stale, while keeping scan's Jev decision.
          // Exclude this round's key so an otherwise-due retry reaches recordNudge's duplicate check.
          const fresh = await snapshot(tx, n.issueId, { lock: true });
          const stillDue = dueNudges({
            ...fresh,
            sent: fresh.sent.filter((s) => s.kind !== n.key),
            ...limits,
            jevCheck: false,
          }).some((d) => d.key === n.key);
          const issue = await getIssue(tx, n.issueId);
          if (!stillDue || !issue.triageRootTs) return "resolved" as const;
          const desk = desks.find((d) => d.id === issue.deskId) ?? fallbackDesk;
          if (!desk) return "resolved" as const;
          // The nudge threads under the card, wherever it was posted.
          const triage = issue.triageChannel ?? desk.triageChannel;
          if (!(await recordNudge(tx, n.issueId, n.key))) return null;
          const card = await post(ctx, {
            channel: triage,
            threadTs: issue.triageRootTs,
            text: `Follow-up on #${issue.number}: ${n.kind.replace(/_/g, " ")}`,
            blocks: nudge(issue, n.kind, null, { triageChannel: triage }),
            key: `nudge:${issue.id}:${n.key}`,
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
          const fresh = await snapshot(tx, e.issueId, { lock: true });
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
          const triage = issue.triageChannel ?? desk.triageChannel;
          const link = permalink(triage, issue.triageRootTs);
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
            channel: triage,
            threadTs: issue.triageRootTs,
            text: `${who} escalation (level ${due.level}) on #${issue.number}: ${why}.`,
            key: `nudge:${e.issueId}:${e.key}`,
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
      // Every issue this run touched; a tick has one, a hand-built send input may name several.
      const issueIds = [
        ...new Set([
          ...(input.issueId ? [input.issueId] : []),
          ...input.nudges.map((n) => n.issueId),
          ...(input.escalations ?? []).map((e) => e.issueId),
        ]),
      ];
      const timers = [];
      for (const id of issueIds)
        timers.push(
          timerOut(await rescheduleIssue(db, ctx, id, { tick: true })),
        );
      return terminate({
        ...(input.issueId ? { issueId: input.issueId } : {}),
        nudged,
        escalated,
        unnotified,
        notSent,
        resolved,
        skipped: input.skipped ?? [],
        jevCheck: input.jevCheck ?? true,
        linear: input.linear ?? null,
        timer: input.issueId
          ? timers.find((t) => t.issueId === input.issueId)
          : undefined,
        ...(input.issueId ? {} : { timers }),
      });
    });
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Support desk controller: runs for one ticket when its timer fires, pings the triage thread while a condition stays stale (no owner, no draft, draft pending, customer waiting), escalates to on-call and a support group past a desk's escalation levels, reads Linear for On Hold tickets, and sets the ticket's next timer.",
  entry: "scan",
  steps: { scan, send },
});
