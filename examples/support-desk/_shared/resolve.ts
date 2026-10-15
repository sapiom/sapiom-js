/**
 * Whether an issue is resolved, and what the desk does about it.
 *
 * Until this module, nothing closed an issue but a person: a customer's "thanks, that worked" in the
 * thread moved the issue back to On You, and the controller's "expects a reply" check only kept it
 * from nudging. The issue then sat open in the digest for days.
 *
 * Now Jev judges the conversation after every move on an issue: a customer message, and a team
 * answer (a reply in the thread, a reaction on the customer's latest message, Handled), since
 * support usually has the last word (intake); and on demand for every open issue (the controller's
 * `review` run). Its probability that nothing is left for the
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

/**
 * Who has the next move on an issue, as Jev's options. Support usually has the last word, so a
 * complete team answer is `done` without the customer replying.
 */
export const NEXT_MOVES = {
  done: "Nothing is left: the team's latest message delivered what was asked (a fix, an answer, a link, the data, a scheduled time), or the customer's latest message only thanks, acknowledges, confirms, or settles a plan or a meeting, or says they will take it from here.",
  team_answer:
    "The customer asked a question, reported a problem, or reported that a fix does not work, and the team has not answered it yet.",
  team_work:
    "The team said it will do or check something ('will follow up', 'working on it', 'will fix') or is waiting on an outside party, and has not reported it done.",
  customer:
    "The team asked the customer something or needs something from them (an answer, a test, a file, a confirmation) and the customer has not replied yet.",
} as const;
export type NextMove = keyof typeof NEXT_MOVES;

export interface Judgement {
  /** Jev's probability of `done`: what the close and suggest thresholds read. */
  done: number;
  /** Jev's single pick. */
  next: NextMove;
  probabilities: Partial<Record<NextMove, number>>;
}

/** Who has the next move on the issue, read from its whole conversation. */
export async function judgeNextMove(
  ctx: JevCtx,
  input: { title: string | null; status: string; thread: ThreadLine[] },
): Promise<Judgement> {
  const recent = input.thread.slice(-RESOLVE_CONTEXT_MESSAGES);
  const res = await ctx.sapiom.decisions.evaluate({
    state: {
      title: input.title ?? "",
      status: input.status,
      lastMessage: recent.at(-1) ?? null,
      thread: recent,
    },
    questions: {
      next_move: {
        type: "choice",
        instructions:
          "Who has the next move in this support conversation? `thread` is the whole conversation, oldest first; `lastMessage` is its latest line, from either side. Support usually has the last word: a team answer that delivers what was asked finishes the request without the customer replying. A support-team line `(reacted :emoji:)` is a teammate's reaction and `(marked handled)` means a teammate answered elsewhere.",
        criteria: { ...NEXT_MOVES },
      },
    },
  });
  const a = res.answers.next_move as {
    choice: string;
    probabilities?: Record<string, number>;
  };
  const probabilities = (a.probabilities ?? {}) as Partial<
    Record<NextMove, number>
  >;
  const next = (a.choice in NEXT_MOVES ? a.choice : "team_answer") as NextMove;
  return {
    done: probabilities.done ?? (next === "done" ? 1 : 0),
    next,
    probabilities,
  };
}

/** Jev's probability that nothing is left for the team to do, whoever spoke last. */
export async function judgeResolved(
  ctx: JevCtx,
  input: { title: string | null; status: string; thread: ThreadLine[] },
): Promise<number> {
  return (await judgeNextMove(ctx, input)).done;
}

/** At or above this, a `customer` pick moves a New or On You issue to On Customer. */
export const CUSTOMER_MOVE_MIN = 0.6;

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
export function verdictReason(
  p: number,
  last: { from: "customer" | "support team"; text: string } | string | null,
): string {
  const line =
    typeof last === "string" ? { from: "customer" as const, text: last } : last;
  const who =
    line?.from === "support team" ? "The team said" : "The customer said";
  const quote = line
    ? ` ${who}: “${slackToPlain(line.text).replace(/\s+/g, " ").slice(0, 140)}”`
    : "";
  return `Jev judged nothing is left to do (${pct(p)}).${quote}`;
}

/**
 * Jev says the customer owes the next move on an issue still waiting on the team (New or On You):
 * move it On Customer, so it leaves the team's queue and the idle close can apply. True when moved.
 */
async function ballToCustomer(
  ctx: Ctx,
  db: Db,
  issueId: string,
  judged: Judgement,
): Promise<boolean> {
  if (
    judged.next !== "customer" ||
    (judged.probabilities.customer ?? 0) < CUSTOMER_MOVE_MIN
  )
    return false;
  const moved = await db.transaction(async (tx) => {
    const locked = await lockIssue(tx, issueId);
    if (locked.status !== "new" && locked.status !== "on_you") return null;
    return setStatus(tx, locked.id, "on_customer");
  });
  if (!moved) return false;
  if (moved.triageRootTs)
    await redrawCard(ctx, db, await cardChannel(db, moved), moved).catch(
      (err: unknown) =>
        ctx.logger.warn("card redraw failed", { issueId, err: String(err) }),
    );
  return true;
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
  /** Who Jev said has the next move. */
  next?: NextMove;
  /** On a dry run: the conversation Jev read, so a verdict can be checked against it. */
  thread?: ThreadLine[];
}> {
  const settings = opts.settings ?? (await resolveSettings(db));
  const issue = await getIssue(db, issueId);
  const messages = await messagesForIssue(db, issueId);
  const thread = threadOf(messages);
  const base = { issueId, number: issue.number };
  if (issue.status === "closed" || thread.length === 0)
    return { ...base, resolved: null, verdict: "open", acted: false };
  let p: number;
  let judged: Judgement;
  try {
    judged = await judgeNextMove(ctx, {
      title: issue.title,
      status: issue.status,
      thread,
    });
    p = judged.done;
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
  if (opts.dryRun)
    return {
      ...base,
      resolved: p,
      verdict,
      next: judged.next,
      acted: false,
      thread: thread.slice(-RESOLVE_CONTEXT_MESSAGES),
    };
  if (verdict === "open")
    return {
      ...base,
      resolved: p,
      verdict,
      next: judged.next,
      acted: await ballToCustomer(ctx, db, issueId, judged),
    };
  const lastMessage =
    messages.filter((m) => m.direction !== "internal").at(-1) ?? null;
  const why = verdictReason(p, thread.at(-1) ?? null);
  const acted =
    verdict === "close"
      ? (await closeOnOwn(ctx, db, issueId, why)).changed
      : await suggestClose(ctx, db, issue, lastMessage?.id ?? issueId, why);
  return { ...base, resolved: p, verdict, acted };
}

/**
 * After a team answer (intake): judge issue `issueId` with its stored conversation and close it or
 * suggest closing it. `refId` (the answering message or event) keys the suggestion, so a redelivered
 * answer suggests once. Never throws: the answer is already recorded, and a failed check only
 * leaves the issue as the answer put it.
 */
export async function judgeAfterAnswer(
  ctx: Ctx & JevCtx,
  db: Db,
  issueId: string,
  refId: string,
): Promise<{ resolved: number | null; verdict: Verdict; acted: boolean }> {
  const none = { resolved: null, verdict: "open" as Verdict, acted: false };
  try {
    const settings = await resolveSettings(db);
    if (!settings.enabled) return none;
    const issue = await getIssue(db, issueId);
    if (issue.status === "closed") return none;
    const thread = threadOf(await messagesForIssue(db, issueId));
    if (thread.length === 0) return none;
    const judged = await judgeNextMove(ctx, {
      title: issue.title,
      status: issue.status,
      thread,
    });
    const p = judged.done;
    const verdict = verdictFor(p, settings);
    if (verdict === "open") {
      await ballToCustomer(ctx, db, issueId, judged);
      return { resolved: p, verdict, acted: false };
    }
    const why = verdictReason(p, thread.at(-1) ?? null);
    const acted =
      verdict === "close"
        ? (await closeOnOwn(ctx, db, issueId, why)).changed
        : await suggestClose(ctx, db, issue, refId, why);
    return { resolved: p, verdict, acted };
  } catch (err) {
    ctx.logger.warn("resolve check after a team answer failed", {
      issueId,
      err: String(err),
    });
    return none;
  }
}
