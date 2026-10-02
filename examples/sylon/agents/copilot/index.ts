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

import {
  ACTIONS,
  decodeAction,
  escapeMrkdwn,
  issueCard,
  issueCardText,
  statusLabel,
} from "../../_shared/blocks";
import { getConfig } from "../../_shared/config";
import { withDb, type Db, type DbCtx } from "../../_shared/db";
import { emit } from "../../_shared/emit";
import { Envelope, SlackBlockActions } from "../../_shared/events";
import {
  canTransition,
  createDraft,
  decideDraft,
  draftForCausation,
  getAccount,
  getDraft,
  getIssue,
  linkMessage,
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
import { KB } from "../../_shared/kb.generated";
import { post, update, type SlackCtx } from "../../_shared/slack";
import {
  DraftOutput,
  OUTPUT_NAME,
  SUPERSEDED_BY,
  SYSTEM_PROMPT,
  VERB_DECISION,
  buildPrompt,
  cardText,
  copilotCard,
  normalizeOutput,
  outputSchema,
} from "./draft";
import { seedLocalFixtures } from "./local";

export const AGENT = "sylon-copilot";

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

async function updateCard(
  ctx: SlackCtx,
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
    blocks: copilotCard(draft, issue, KB, note),
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

/**
 * The drafting path, run inside the entry step: one step boundary fewer is about two seconds off
 * the 15 s card budget.
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
    // pays for a second LLM call or posts a second card.
    let draft = await draftForCausation(db, issue.id, trigger.causationId);
    let confidence: number | null = null;
    if (!draft) {
      const superseded: Draft[] = [];
      for (const pending of await pendingDrafts(db, issue.id)) {
        const decided = await decideDraft(
          db,
          pending.id,
          "superseded",
          SUPERSEDED_BY,
        );
        if (decided.changed) superseded.push(decided.draft);
      }
      const [account, stored] = await Promise.all([
        getAccount(db, issue.accountId),
        messagesForIssue(db, issue.id),
      ]);
      const messages = withTriggerMessage(stored, trigger);
      const current = issue;
      // The old cards update while the model drafts; neither waits on the other.
      const [response] = await Promise.all([
        ctx.sapiom.llm.run({
          request: {
            system: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: buildPrompt({
                  issue: current,
                  account,
                  messages,
                  kb: KB,
                }),
              },
            ],
            max_tokens: 8192,
          },
          output: { name: OUTPUT_NAME, schema: outputSchema(KB) },
        }),
        ...superseded.map((d) => updateCard(ctx, d, current)),
      ]);
      const output = normalizeOutput(
        DraftOutput.parse(ctx.sapiom.llm.structuredOf(response, OUTPUT_NAME)),
        KB,
      );
      confidence = output.confidence;
      issue = await updateIssue(db, issue.id, { summary: output.summary });
      // An empty reply means the model sees nothing to answer yet. A card would offer Approve
      // on nothing, so there is none; the next customer message drafts again.
      if (!output.reply)
        return terminate({
          issueId: issue.id,
          skipped: "no reply needed",
          summary: output.summary,
          confidence,
        });
      draft = await createDraft(db, {
        issueId: issue.id,
        text: output.reply,
        citations: output.citations,
        causationId: trigger.causationId,
        confidence: output.confidence,
      });
    }
    const reused = !!draft.cardTs;
    if (!draft.cardTs) {
      const posted = await post(ctx, {
        channel: await getConfig(db, "channels.triage"),
        threadTs: triageRootTs,
        text: cardText(issue),
        blocks: copilotCard(draft, issue, KB),
      });
      draft = await setDraftCard(db, draft.id, posted);
    }
    return terminate({
      issueId: issue.id,
      draftId: draft.id,
      cardTs: draft.cardTs,
      status: draft.status,
      confidence,
      reused,
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
      if (!found) return terminate({ skipped: "draft not found" });
      await recordRun(db, ctx, AGENT, found.issueId);
      const { draft, changed } = await decideDraft(
        db,
        found.id,
        VERB_DECISION[verb],
        click.user.id,
      );
      if (!changed) {
        // Someone (or a superseding draft) decided first: show that, do nothing else.
        const issue = await getIssue(db, draft.issueId);
        await updateCard(ctx, draft, issue, undefined, {
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
        // Keyed on the draft, so a retry after the post never sends the reply twice.
        const sourceEventId = `draft:${draft.id}`;
        let sent = await messageBySourceEventId(db, sourceEventId);
        if (!sent) {
          const posted = await post(ctx, {
            channel: issue.customerChannel,
            threadTs: issue.customerRootTs,
            text: escapeMrkdwn(draft.text),
          });
          sent = (
            await linkMessage(db, {
              issueId: issue.id,
              source: "slack",
              sourceEventId,
              direction: "agent",
              slack: {
                channel: posted.channel,
                ts: posted.ts,
                threadTs: issue.customerRootTs,
              },
              userId: clicker,
              text: draft.text,
            })
          ).message;
        }
        out.replyTs = sent.ts;
        if (canTransition(issue.status, "on_customer")) {
          issue = await setStatus(db, issue.id, "on_customer");
          await refreshIssueCard(ctx, db, issue);
        } else {
          note = `Status left at ${statusLabel(issue.status)}: it cannot move to On Customer from there.`;
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

      await updateCard(ctx, draft, issue, note, {
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
    const triage = await getConfig(db, "channels.triage");
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
    "Sylon copilot: drafts a reply card for each issue event and handles Approve / Escalate / Dismiss.",
  entry: "receive",
  steps: { receive, decide, apply },
});
