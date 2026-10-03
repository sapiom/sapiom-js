/**
 * copilot: drafts a reply for every new issue or customer follow-up, posts it as a card in the
 * issue's triage thread, and acts on the teammate's click. Stateless: the drafting run ends once
 * the card is posted; every click is a new run.
 *
 * Triggers: events `issue.created`, `issue.message_added`, `slack.block_actions`. Clicks whose
 * action id is not `draft.*` exit in `receive` (intake owns `issue.*`).
 *
 *   receive ─┬─ (issue event: draft and post the card, end)
 *            └─ decide ─── apply   (draft.* click)
 *
 * Drafting runs inside the entry step because every step boundary costs about two seconds and
 * the card has a 15 s budget. A retry still never drafts twice: the stored draft is keyed on the
 * event's causationId. The decision and its effects are separate steps so a failed effect retries
 * without the committed decision reading as someone else's.
 */
import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
  type Terminate,
} from "@sapiom/agent";
import { z } from "zod/v4";

import { agentSlug } from "../../_shared/fleet-id";
import {
  ACTIONS,
  decodeAction,
  escapeMrkdwn,
  issueCard,
  issueCardText,
  statusLabel,
  workingCard,
} from "../../_shared/blocks";
import { deskForIssue } from "../../_shared/desks";
import { withDb, type Db, type DbCtx } from "../../_shared/db";
import { emit } from "../../_shared/emit";
import { Envelope, SlackBlockActions } from "../../_shared/events";
import {
  canTransition,
  createDraftOnce,
  decideDraft,
  draftForCausation,
  getAccount,
  getDraft,
  getIssue,
  linkMessage,
  lockIssue,
  messageBySourceEventId,
  messagesForIssue,
  pendingDrafts,
  recordRun,
  setDraftCard,
  setStatus,
  updateIssue,
  type Draft,
  type Issue,
  type Message,
} from "../../_shared/issues";
import { articleTitles } from "../../_shared/kb";
import {
  type SlackCtx,
  post,
  restoreClicked,
  showWorking,
  update,
} from "../../_shared/slack";
import {
  DRAFT_FAILED_NOTE,
  DraftOutput,
  OUTPUT_NAME,
  SUPERSEDED_BY,
  SYSTEM_PROMPT,
  TOOL_REMINDER,
  VERB_DECISION,
  buildPrompt,
  cardText,
  citedSources,
  copilotCard,
  normalizeOutput,
  outputSchema,
  responseShape,
} from "./draft";
import { gatherKnowledge } from "./gather";
import {
  DOCS_OUTAGE_CONFIDENCE_CAP,
  DOCS_PARTIAL_CONFIDENCE_CAP,
  citable,
} from "./knowledge";
import { seedLocalFixtures } from "./local";

export const AGENT = agentSlug("copilot");

/** `issue.created` or `issue.message_added` (which adds `messageId` and `text`). */
const DraftTrigger = Envelope.extend({
  messageId: z.string().optional(),
  text: z.string().optional(),
});
type DraftTrigger = z.infer<typeof DraftTrigger>;

const ApplyIn = z.object({
  click: SlackBlockActions,
  draftId: z.string().uuid(),
});

const UUID = z.string().uuid();

/** Open the db; on a local trace, add the fixtures' issue and drafts first. */
function db<R>(ctx: DbCtx, fn: (db: Db) => Promise<R>): Promise<R> {
  return withDb(ctx, async (d) => {
    if (ctx.isLocalTrace) await seedLocalFixtures(d);
    return fn(d);
  });
}

/**
 * Redraw a draft card from persisted state. For an approved draft the outcome line comes from
 * whether its `draft:<id>` message exists, so every redraw (apply, a stale click, a supersede)
 * tells the same truth about delivery.
 */
async function updateCard(
  ctx: SlackCtx,
  db: Db,
  draft: Draft,
  issue: Issue,
  note?: string,
  fallback?: { channel?: string; ts?: string },
): Promise<void> {
  const channel = draft.cardChannel ?? fallback?.channel;
  const ts = draft.cardTs ?? fallback?.ts;
  if (!channel || !ts) {
    ctx.logger.warn("draft has no card to update", { draftId: draft.id });
    return;
  }
  await update(ctx, {
    channel,
    ts,
    text: cardText(issue),
    blocks: copilotCard(
      draft,
      issue,
      await articleTitles(db, citedSources(draft)),
      note,
      draft.status === "approved"
        ? !!(await messageBySourceEventId(db, `draft:${draft.id}`))
        : undefined,
    ),
  });
}

/**
 * The thread, plus the triggering follow-up if it is not stored on the issue yet, so the draft
 * always answers the message that caused it.
 */
function withTriggerMessage(
  messages: Message[],
  trigger: DraftTrigger,
): Message[] {
  if (!trigger.messageId || trigger.text === undefined) return messages;
  if (messages.some((m) => m.id === trigger.messageId)) return messages;
  return [
    ...messages,
    {
      id: trigger.messageId,
      issueId: trigger.issueId,
      source: trigger.source,
      sourceEventId: trigger.causationId,
      channel: trigger.slack.channel,
      ts: trigger.slack.ts,
      threadTs: trigger.slack.threadTs ?? null,
      userId: null,
      userName: null,
      direction: "customer",
      text: trigger.text,
      jev: null,
      createdAt: new Date(),
    },
  ];
}

/** The Slack ts of the customer message that triggered a draft, when it is stored. */
async function triggerTs(db: Db, draft: Draft): Promise<number | null> {
  if (!draft.causationId) return null;
  const message = await messageBySourceEventId(db, draft.causationId);
  return message?.ts ? Number(message.ts) : null;
}

/** A pending draft with a posted card that answers a newer customer message than the trigger's. */
async function newerPostedDraft(
  db: Db,
  issueId: string,
  trigger: DraftTrigger,
): Promise<Draft | undefined> {
  const ours = Number(trigger.slack.ts);
  for (const pending of await pendingDrafts(db, issueId)) {
    const theirs = await triggerTs(db, pending);
    if (pending.cardTs && theirs !== null && theirs > ours) return pending;
  }
  return undefined;
}

/**
 * Covers thinking plus the forced tool call: a routed label may think before it
 * answers, and those tokens come out of the same cap.
 */
const DRAFT_MAX_TOKENS = 8192;
const DRAFT_MODEL = "sonnet";

/** Attempts per draft. A second identical step retry would only repeat the miss and its cost. */
const DRAFT_ATTEMPTS = 2;

/**
 * The drafting call, retried once inside the step when the model answers without the forced
 * `draft_reply` call. `run` forces `tool_choice` on every attempt; the retry also says so in the
 * system prompt. Returns null when no attempt produced a valid draft. A cap that cuts the call
 * short throws `LlmStructuredOutputTruncatedError` from `run` instead.
 */
async function requestDraft(
  ctx: AgentExecutionContext<Record<string, unknown>>,
  prompt: string,
  allowedCitations: readonly string[],
): Promise<DraftOutput | null> {
  for (let attempt = 1; attempt <= DRAFT_ATTEMPTS; attempt++) {
    const response = await ctx.sapiom.llm.run({
      // A routing label, not a model id. With no model the gateway routes to `smart`, whose
      // self-hosted model ignored the forced tool call on both attempts (execution 848839).
      model: DRAFT_MODEL,
      request: {
        system:
          attempt === 1
            ? SYSTEM_PROMPT
            : `${SYSTEM_PROMPT}\n\n${TOOL_REMINDER}`,
        messages: [{ role: "user", content: prompt }],
        max_tokens: DRAFT_MAX_TOKENS,
      },
      output: { name: OUTPUT_NAME, schema: outputSchema(allowedCitations) },
    });
    const structured = ctx.sapiom.llm.structuredOf(response, OUTPUT_NAME);
    const parsed = DraftOutput.safeParse(structured);
    if (parsed.success) return parsed.data;
    // The run record does not keep the response; this line is the only trace of why it missed.
    ctx.logger.warn("draft response has no structured output", {
      attempt,
      toolCall: structured === undefined ? "missing" : "invalid",
      ...responseShape(response),
    });
  }
  return null;
}

/**
 * Tell the triage thread no draft is coming, so a teammate replies by hand. Never fails the run:
 * a throw here would retry the step and pay for both LLM attempts again.
 */
async function postDraftFailedNote(
  ctx: SlackCtx,
  db: Db,
  issue: Issue,
  triageRootTs: string,
): Promise<void> {
  try {
    await post(ctx, {
      channel: (await deskForIssue(db, issue)).triageChannel,
      threadTs: triageRootTs,
      text: DRAFT_FAILED_NOTE,
    });
  } catch (err) {
    ctx.logger.warn("draft-failed note not posted; continuing", {
      err: String(err),
    });
  }
}

/**
 * The drafting path, run inside the entry step: one step boundary fewer is about two seconds off
 * the 15 s card budget.
 *
 * Order matters: the new card is posted before any older pending draft is superseded, so a model
 * error, an empty reply or a failed post leaves the old cards actionable.
 */
async function draftReply(
  trigger: DraftTrigger,
  ctx: AgentExecutionContext<Record<string, unknown>>,
): Promise<Terminate> {
  return db(ctx, async (db) => {
    await recordRun(db, ctx, AGENT, trigger.issueId);
    let issue = await getIssue(db, trigger.issueId).catch(() => null);
    if (!issue) return terminate({ skipped: "issue not found" });
    if (issue.status === "closed")
      return terminate({ skipped: "issue is closed", issueId: issue.id });
    // Intake posts the issue card before it emits; without it there is no thread to post in.
    const triageRootTs = issue.triageRootTs;
    if (!triageRootTs)
      throw new Error(`issue ${issue.id} has no triage card yet`);

    // A retried step or a redelivered event finds the draft it already produced, so it never
    // pays for a second LLM call.
    let draft = await draftForCausation(db, issue.id, trigger.causationId);
    let confidence: number | null = null;
    if (!draft) {
      // A late event must not replace the posted draft for a newer customer message. A newer
      // draft without a card (its post failed or is in flight) does not stop us: if ours were
      // dropped too, the customer could be left with no actionable reply.
      const newer = await newerPostedDraft(db, issue.id, trigger);
      if (newer)
        return terminate({
          issueId: issue.id,
          skipped: "a newer message already has a pending draft",
          draftId: newer.id,
        });

      const [account, stored] = await Promise.all([
        getAccount(db, issue.accountId),
        messagesForIssue(db, issue.id),
      ]);
      const messages = withTriggerMessage(stored, trigger);
      const knowledge = await gatherKnowledge(ctx, db, { issue, messages });
      const allowed = citable(knowledge);
      const raw = await requestDraft(
        ctx,
        buildPrompt({ issue, account, messages, knowledge }),
        allowed,
      );
      if (!raw) {
        // A concurrent delivery of this event may have drafted while ours missed: publish its
        // row below, as a retry would, so a card whose post failed or is in flight still lands.
        draft = await draftForCausation(db, issue.id, trigger.causationId);
        if (!draft) {
          // A newer message's posted card is actionable; "reply by hand" next to it would be wrong.
          const newer = await newerPostedDraft(db, issue.id, trigger);
          if (!newer) await postDraftFailedNote(ctx, db, issue, triageRootTs);
          return terminate({
            issueId: issue.id,
            skipped: "no structured draft",
            ...(newer && { draftId: newer.id }),
          });
        }
        issue = await getIssue(db, issue.id);
      } else {
        const output = normalizeOutput(raw, allowed);
        // Without the docs the draft rests on less than a reviewer assumes; say so in the number.
        if (knowledge.docsUnavailable)
          output.confidence = Math.min(
            output.confidence,
            knowledge.docs.length > 0
              ? DOCS_PARTIAL_CONFIDENCE_CAP
              : DOCS_OUTAGE_CONFIDENCE_CAP,
          );
        confidence = output.confidence;
        issue = await updateIssue(db, issue.id, { summary: output.summary });
        // An empty reply means the model sees nothing to answer yet. A card would offer Approve
        // on nothing, so there is none, and the older drafts stay as they are.
        if (!output.reply)
          return terminate({
            issueId: issue.id,
            skipped: "no reply needed",
            summary: output.summary,
            confidence,
          });
        // The unique (issue_id, causation_id) index makes this one row per event even when two
        // deliveries race; the loser continues with the winner's row and publishes below.
        draft = (
          await createDraftOnce(db, {
            issueId: issue.id,
            text: output.reply,
            citations: output.citations,
            causationId: trigger.causationId,
            confidence: output.confidence,
          })
        ).draft;
      }
    }

    const triage = (await deskForIssue(db, issue)).triageChannel;
    const ours = Number(trigger.slack.ts);
    const current = issue;
    const mine = draft;
    const titles = await articleTitles(db, citedSources(mine));
    // Publication is serialized per issue under the issue row lock: a second delivery of this
    // event waits and finds the card posted, and two different events cannot both leave an
    // actionable card. The lock is held across the Slack post on purpose.
    const published = await db.transaction(async (tx) => {
      await lockIssue(tx, current.id);
      let own = await getDraft(tx, mine.id);
      const others = (await pendingDrafts(tx, current.id)).filter(
        (d) => d.id !== own.id,
      );
      const newer: Draft[] = [];
      const older: Draft[] = [];
      for (const other of others) {
        const theirs = await triggerTs(tx, other);
        if (theirs === null || theirs <= ours) older.push(other);
        // A newer draft without a card is neither retired by us nor a reason to retire ours:
        // its own publish supersedes ours once its card is posted.
        else if (other.cardTs) newer.push(other);
      }
      // A newer message's draft is already posted: ours would be stale.
      if (!own.cardTs && own.status === "pending" && newer.length > 0) {
        own = (await decideDraft(tx, own.id, "superseded", SUPERSEDED_BY))
          .draft;
        return { own, retired: [] as Draft[], stale: true, posted: false };
      }
      let posted = false;
      if (!own.cardTs && own.status === "pending") {
        const card = await post(ctx, {
          channel: triage,
          threadTs: triageRootTs,
          text: cardText(current),
          blocks: copilotCard(own, current, titles),
        });
        own = await setDraftCard(tx, own.id, card);
        posted = true;
      }
      // Retire the older pending drafts only now that ours is posted. Also runs on a retry, so a
      // crash after the post never leaves two actionable cards.
      const retired: Draft[] = [];
      if (own.status === "pending")
        for (const other of older) {
          const decided = await decideDraft(
            tx,
            other.id,
            "superseded",
            SUPERSEDED_BY,
          );
          if (decided.changed) retired.push(decided.draft);
        }
      return { own, retired, stale: false, posted };
    });
    for (const old of published.retired) await updateCard(ctx, db, old, issue);
    if (published.stale)
      return terminate({
        issueId: issue.id,
        draftId: published.own.id,
        skipped: "a newer message already has a pending draft",
      });
    return terminate({
      issueId: issue.id,
      draftId: published.own.id,
      cardTs: published.own.cardTs,
      status: published.own.status,
      confidence,
      // False only for the run that posted the card.
      reused: !published.posted,
    });
  });
}

const receive = defineStep({
  name: "receive",
  next: ["decide"],
  terminal: true,
  // Loose on purpose: one entry receives three event shapes; each branch parses its own.
  inputSchema: z.looseObject({}),
  async run(input, ctx) {
    if (input.type === "block_actions") {
      const click = SlackBlockActions.safeParse(input);
      if (!click.success) return terminate({ skipped: "malformed click" });
      const action = click.data.actions[0];
      const decoded = decodeAction(action.action_id);
      if (decoded?.owner !== "draft")
        return terminate({
          skipped: `not a draft action: ${action.action_id}`,
        });
      if (!(ACTIONS.draft as readonly string[]).includes(decoded.verb))
        return terminate({ skipped: `unknown draft verb: ${decoded.verb}` });
      // A rejected click gets no placeholder.
      if (!UUID.safeParse(action.value).success)
        return terminate({ skipped: "value is not a draftId" });
      // Before any database work, so the click shows within a second or two; `apply` redraws.
      await showWorking(ctx, click.data, decoded.verb, workingCard);
      return goto("decide", click.data);
    }
    const trigger = DraftTrigger.safeParse(input);
    if (!trigger.success)
      return terminate({ skipped: "neither an issue event nor a click" });
    return draftReply(trigger.data, ctx);
  },
});

const decide = defineStep({
  name: "decide",
  next: ["apply"],
  terminal: true,
  inputSchema: SlackBlockActions,
  async run(click, ctx) {
    const action = click.actions[0];
    const verb = decodeAction(action.action_id)!.verb;
    const draftId = UUID.safeParse(action.value);
    if (!draftId.success)
      return terminate({ skipped: "value is not a draftId" });
    return db(ctx, async (db) => {
      await recordRun(db, ctx, AGENT);
      const found = await getDraft(db, draftId.data).catch(() => null);
      if (!found) {
        await restoreClicked(ctx, click);
        return terminate({ skipped: "draft not found" });
      }
      await recordRun(db, ctx, AGENT, found.issueId);
      // A reply drafted before the issue closed must not reach the customer: Approve on a closed
      // issue dismisses the draft instead.
      const issueNow = await getIssue(db, found.issueId);
      if (verb === "approve" && issueNow.status === "closed") {
        const dismissed = await decideDraft(
          db,
          found.id,
          "dismissed",
          click.user.id,
        );
        await updateCard(
          ctx,
          db,
          dismissed.draft,
          issueNow,
          dismissed.changed ? "Issue is closed; reply not sent." : undefined,
          {
            channel: click.container?.channel_id,
            ts: click.container?.message_ts,
          },
        );
        return terminate({
          draftId: dismissed.draft.id,
          changed: dismissed.changed,
          status: dismissed.draft.status,
          decidedBy: dismissed.draft.decidedBy,
          skipped: "issue is closed",
        });
      }
      const { draft, changed } = await decideDraft(
        db,
        found.id,
        VERB_DECISION[verb],
        click.user.id,
      );
      if (!changed) {
        // Someone (or a superseding draft) decided first: show that, do nothing else.
        const issue = await getIssue(db, draft.issueId);
        await updateCard(ctx, db, draft, issue, undefined, {
          channel: click.container?.channel_id,
          ts: click.container?.message_ts,
        });
        return terminate({
          draftId: draft.id,
          changed: false,
          status: draft.status,
          decidedBy: draft.decidedBy,
        });
      }
      return goto("apply", { click, draftId: draft.id });
    });
  },
});

const apply = defineStep({
  name: "apply",
  terminal: true,
  inputSchema: ApplyIn,
  async run({ click, draftId }, ctx) {
    return db(ctx, async (db) => {
      const draft = await getDraft(db, draftId);
      let issue = await getIssue(db, draft.issueId);
      const clicker = click.user.id;
      const out: Record<string, unknown> = {
        draftId,
        issueId: issue.id,
        changed: true,
        status: draft.status,
      };
      let note: string | undefined;

      if (draft.status === "approved") {
        if (!issue.customerChannel || !issue.customerRootTs)
          throw new Error(`issue ${issue.id} has no customer thread`);
        const customerChannel = issue.customerChannel;
        const customerRootTs = issue.customerRootTs;
        // Keyed on the draft, so a retry after the post never sends the reply twice.
        const sourceEventId = `draft:${draft.id}`;
        // Under the issue row lock, so a close (setStatus locks the same row) cannot land between
        // the status check and the send.
        const sent = await db.transaction(async (tx) => {
          const locked = await lockIssue(tx, issue.id);
          const already = await messageBySourceEventId(tx, sourceEventId);
          if (already) return already;
          if (locked.status === "closed") return null;
          const posted = await post(ctx, {
            channel: customerChannel,
            threadTs: customerRootTs,
            text: escapeMrkdwn(draft.text),
          });
          return (
            await linkMessage(tx, {
              issueId: issue.id,
              source: "slack",
              sourceEventId,
              direction: "agent",
              slack: {
                channel: posted.channel,
                ts: posted.ts,
                threadTs: customerRootTs,
              },
              userId: clicker,
              text: draft.text,
            })
          ).message;
        });
        issue = await getIssue(db, issue.id);
        if (!sent) {
          // The click happened, so the decision stays approved; the redraw below reads the
          // missing message and says nothing went out.
          out.replySent = false;
        } else {
          out.replyTs = sent.ts;
          if (canTransition(issue.status, "on_customer")) {
            issue = await setStatus(db, issue.id, "on_customer");
            await refreshIssueCard(ctx, db, issue);
          } else {
            note = `Status left at ${statusLabel(issue.status)}: it cannot move to On Customer from there.`;
          }
        }
        out.issueStatus = issue.status;
      } else if (draft.status === "escalated") {
        const receipt = await emit(ctx, db, "issue.escalate", {
          issueId: issue.id,
          accountId: issue.accountId,
          source: "slack",
          causationId: click.trigger_id,
          slack: {
            channel: issue.customerChannel ?? "",
            ts: issue.customerRootTs ?? "",
          },
          summary: issue.summary ?? draft.text,
          requestedBy: clicker,
        });
        out.receiptId = receipt.receiptId;
        out.duplicate = receipt.duplicate;
      }

      await updateCard(ctx, db, draft, issue, note, {
        channel: click.container?.channel_id,
        ts: click.container?.message_ts,
      });
      return terminate(out);
    });
  },
});

/** The issue card shows the status; keep it current after Approve moves it. Never fails the run. */
async function refreshIssueCard(
  ctx: SlackCtx,
  db: Db,
  issue: Issue,
): Promise<void> {
  if (!issue.triageRootTs) return;
  try {
    const triage = (await deskForIssue(db, issue)).triageChannel;
    const account = await getAccount(db, issue.accountId);
    await update(ctx, {
      channel: triage,
      ts: issue.triageRootTs,
      text: issueCardText(issue, account),
      blocks: issueCard(issue, account),
    });
  } catch (err) {
    ctx.logger.warn("issue card refresh failed; continuing", {
      err: String(err),
    });
  }
}

export const agent = defineAgent({
  name: AGENT,
  description:
    "Support desk copilot: drafts a reply card for each issue event and handles Approve / Escalate / Dismiss.",
  entry: "receive",
  steps: { receive, decide, apply },
});
