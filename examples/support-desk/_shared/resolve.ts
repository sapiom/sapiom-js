/**
 * Whether an issue is resolved, and what the desk does about it.
 *
 * Until this module, nothing closed an issue but a person: a customer's "thanks, that worked" in the
 * thread moved the issue back to On You, and the controller's "expects a reply" check only kept it
 * from nudging. The issue then sat open in the digest for days.
 *
 * Now Jev judges the conversation whenever the customer writes on an issue (intake), and on demand
 * for every open issue (the controller's `review` run). Its probability that nothing is left for the
 * team to do picks one of three outcomes ({@link verdictFor}):
 * - `close`: the desk closes the issue and says so in the triage thread, with a Reopen button;
 * - `suggest`: the issue keeps its status (a thank-you does not hand the ball back to the team) and
 *   the triage thread gets a "Looks resolved" line with a Close button;
 * - `open`: nothing changes.
 *
 * An On Customer issue the customer never answers closes after `resolve.idleCloseHours`, when set
 * (the controller's tick, through `_shared/timers.ts`).
 */
import type { AgentExecutionContext } from "@sapiom/agent";

import { autoClosedNote, closeSuggestion, slackToPlain } from "./blocks";
import { getConfigFresh, type ResolveConfig } from "./config";
import type { Db, DbCtx } from "./db";
import { cardChannel } from "./desks";
import type { EmitCtx } from "./emit";
import {
  getIssue,
  lockIssue,
  messagesForIssue,
  recordNudge,
  setStatus,
  type Issue,
  type Message,
} from "./issues";
import { noteOpenLinear, redrawCard } from "./linear-check";
import { post } from "./slack";

/** Applied under any `resolve` key the config leaves unset. */
export const RESOLVE_DEFAULTS = {
  enabled: true,
  closeMin: 0.85,
  suggestMin: 0.6,
  idleCloseHours: null as number | null,
};
export type ResolveSettings = typeof RESOLVE_DEFAULTS;

/** How much of the conversation Jev reads, newest last. */
export const RESOLVE_CONTEXT_MESSAGES = 12;

export type Verdict = "close" | "suggest" | "open";

export async function resolveSettings(db: Db): Promise<ResolveSettings> {
  const set: ResolveConfig = await getConfigFresh(db, "resolve", {});
  return {
    enabled: set.enabled ?? RESOLVE_DEFAULTS.enabled,
    closeMin: set.closeMin ?? RESOLVE_DEFAULTS.closeMin,
    suggestMin: set.suggestMin ?? RESOLVE_DEFAULTS.suggestMin,
    idleCloseHours: set.idleCloseHours ?? RESOLVE_DEFAULTS.idleCloseHours,
  };
}

export function verdictFor(p: number | null, s: ResolveSettings): Verdict {
  if (p === null || !s.enabled) return "open";
  if (p >= s.closeMin) return "close";
  if (p >= s.suggestMin) return "suggest";
  return "open";
}

/** One line of the conversation as Jev reads it. */
export interface ThreadLine {
  from: "customer" | "support team";
  text: string;
}

/** The stored customer and team messages of an issue, oldest first (internal notes left out). */
export function threadOf(messages: readonly Message[]): ThreadLine[] {
  return messages
    .filter((m) => m.direction !== "internal" && (m.text ?? "").trim())
    .map((m) => ({
      from: m.direction === "customer" ? "customer" : "support team",
      text: slackToPlain(m.text ?? ""),
    }));
}

export async function issueThread(
  db: Db,
  issueId: string,
): Promise<ThreadLine[]> {
  return threadOf(await messagesForIssue(db, issueId));
}

type JevCtx = Pick<AgentExecutionContext<Record<string, unknown>>, "sapiom">;

/** Jev's probability that the issue needs nothing more from the support team. */
export async function judgeResolved(
  ctx: JevCtx,
  input: { title: string | null; status: string; thread: ThreadLine[] },
): Promise<number> {
  const recent = input.thread.slice(-RESOLVE_CONTEXT_MESSAGES);
  const res = await ctx.sapiom.decisions.evaluate({
    state: {
      title: input.title ?? "",
      status: input.status,
      lastMessage: recent.at(-1) ?? null,
      thread: recent,
    },
    questions: {
      resolved: {
        type: "noul",
        instructions:
          "Is this support request resolved, so the support team has nothing left to do unless the customer writes again? `thread` is the conversation, oldest first; `lastMessage` is its latest line. A support-team line `(reacted :emoji:)` is a teammate's reaction and `(marked handled)` means a teammate answered elsewhere.",
        criteria: {
          true: "The customer confirms it works or that their question is answered, thanks the team without asking anything new, says they no longer need help or will take it from here, or agreed to a plan whose remaining steps are the customer's own. A team answer the customer acknowledged counts.",
          false:
            "The latest customer message asks something, says the problem still happens, raises a new problem, or waits on something the team said it would do; or the request itself is not done yet, whoever spoke last.",
        },
      },
    },
  });
  return res.answers.resolved.noul;
}

type Ctx = DbCtx & EmitCtx;

/**
 * Close issue `issueId` on the desk's own judgment: set Closed under the row lock, redraw the card,
 * and post `why` in the triage thread with a Reopen button. False when it was already closed (a
 * retry, or a teammate got there first), in which case nothing is posted.
 */
export async function closeOnOwn(
  ctx: Ctx,
  db: Db,
  issueId: string,
  why: string,
): Promise<{ issue: Issue; changed: boolean }> {
  const out = await db.transaction(async (tx) => {
    const locked = await lockIssue(tx, issueId);
    if (locked.status === "closed") return { issue: locked, changed: false };
    return { issue: await setStatus(tx, locked.id, "closed"), changed: true };
  });
  if (!out.changed || !out.issue.triageRootTs) return out;
  const channel = await cardChannel(db, out.issue);
  try {
    await redrawCard(ctx, db, channel, out.issue);
    await post(ctx, {
      channel,
      threadTs: out.issue.triageRootTs,
      text: `Closed #${out.issue.number}: ${why}`,
      blocks: autoClosedNote(out.issue, why),
      key: `resolve:closed:${out.issue.id}:${out.issue.closedAt?.getTime() ?? 0}`,
    });
  } finally {
    // As a teammate's Close does: a still-open Linear ticket is flagged, whatever Slack did.
    await noteOpenLinear(ctx, channel, out.issue);
  }
  return out;
}

/**
 * Suggest closing `issue` in its triage thread, once per customer message (`refId`). False when this
 * message already had its suggestion, or the issue has no card to post under.
 */
export async function suggestClose(
  ctx: Ctx,
  db: Db,
  issue: Issue,
  refId: string,
  why: string,
): Promise<boolean> {
  if (!issue.triageRootTs || issue.status === "closed") return false;
  if (!(await recordNudge(db, issue.id, `resolve:suggest:${refId}`)))
    return false;
  await post(ctx, {
    channel: await cardChannel(db, issue),
    threadTs: issue.triageRootTs,
    text: `Looks resolved: #${issue.number}. ${why}`,
    blocks: closeSuggestion(issue, why),
    key: `resolve:suggest:${issue.id}:${refId}`,
  });
  return true;
}

/**
 * When an On Customer issue closes for want of a customer reply: `hours` after its newest customer
 * or team message (its creation, with none). Null for any other status, or when `hours` is unset.
 */
export function idleCloseAt(
  issue: { status: string; createdAt: Date },
  messages: readonly { direction: string; createdAt: Date }[],
  hours: number | null,
): Date | null {
  if (hours === null || issue.status !== "on_customer") return null;
  const last = messages
    .filter((m) => m.direction !== "internal")
    .reduce(
      (t, m) => Math.max(t, m.createdAt.getTime()),
      issue.createdAt.getTime(),
    );
  return new Date(last + hours * 3600_000);
}

/** The line posted with an idle close. */
export function idleReason(hours: number): string {
  const span =
    hours % 24 === 0
      ? `${hours / 24} day${hours === 24 ? "" : "s"}`
      : `${hours} hours`;
  return `no reply from the customer in ${span}. Reopen it if they still need help; a new message from them reopens it too.`;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** The reason line posted with an automatic close or a suggestion. */
export function verdictReason(p: number, lastCustomer: string | null): string {
  const quote = lastCustomer
    ? ` The customer said: “${slackToPlain(lastCustomer).replace(/\s+/g, " ").slice(0, 140)}”`
    : "";
  return `Jev judged it resolved (${pct(p)}).${quote}`;
}

/**
 * Judge `issueId` now and act on the verdict: close, suggest, or leave it. For the controller's
 * review of open issues; intake applies the verdict itself, inside its own status move.
 */
export async function reviewIssue(
  ctx: Ctx & JevCtx,
  db: Db,
  issueId: string,
  opts: { dryRun?: boolean; settings?: ResolveSettings } = {},
): Promise<{
  issueId: string;
  number: number;
  resolved: number | null;
  verdict: Verdict;
  acted: boolean;
  error?: string;
}> {
  const settings = opts.settings ?? (await resolveSettings(db));
  const issue = await getIssue(db, issueId);
  const messages = await messagesForIssue(db, issueId);
  const thread = threadOf(messages);
  const base = { issueId, number: issue.number };
  if (issue.status === "closed" || thread.length === 0)
    return { ...base, resolved: null, verdict: "open", acted: false };
  let p: number;
  try {
    p = await judgeResolved(ctx, {
      title: issue.title,
      status: issue.status,
      thread,
    });
  } catch (err) {
    return {
      ...base,
      resolved: null,
      verdict: "open",
      acted: false,
      error: String(err),
    };
  }
  const verdict = verdictFor(p, settings);
  if (opts.dryRun || verdict === "open")
    return { ...base, resolved: p, verdict, acted: false };
  const lastCustomer =
    messages.filter((m) => m.direction === "customer").at(-1) ?? null;
  const why = verdictReason(p, lastCustomer?.text ?? null);
  const acted =
    verdict === "close"
      ? (await closeOnOwn(ctx, db, issueId, why)).changed
      : await suggestClose(ctx, db, issue, lastCustomer?.id ?? issueId, why);
  return { ...base, resolved: p, verdict, acted };
}
