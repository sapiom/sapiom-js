/**
 * smoke-ingest: the E2 walking skeleton's front half. A top-level message in a customer channel
 * becomes an `issues` row (through _shared/issues.ts), an issue card in the triage channel, and an
 * `issue.created` event. Deliberately no classification: E3's intake replaces this agent.
 *
 * Trigger: event `slack.message.created`. Triggers match on type only, so `guard` filters.
 */
import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";

import { issueCard, issueCardText } from "../../_shared/blocks";
import { customerChannel, getConfig } from "../../_shared/config";
import { withDb } from "../../_shared/db";
import { emit } from "../../_shared/emit";
import { SlackMessageCreated } from "../../_shared/events";
import {
  accountByChannel,
  attachMessage,
  getIssue,
  linkMessage,
  openIssue,
  recordRun,
  setTriageRoot,
  upsertAccount,
} from "../../_shared/issues";
import { post } from "../../_shared/slack";

export const AGENT = "sylon-smoke-ingest";

/** First 80 chars of the message, without Slack's `<@U…>` / `<url|label>` tokens. */
export function titleOf(text: string): string {
  return (
    text
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "(no text)"
  );
}

const guard = defineStep({
  name: "guard",
  next: ["ingest"],
  terminal: true,
  inputSchema: SlackMessageCreated,
  async run(input, ctx) {
    const e = input.event;
    if (e.subtype || e.bot_id)
      return terminate({ skipped: "bot or edited message" });
    if (e.thread_ts && e.thread_ts !== e.ts)
      return terminate({ skipped: "thread reply" });
    const channel = await withDb(ctx, (db) => customerChannel(db, e.channel));
    if (!channel)
      return terminate({ skipped: `not a customer channel: ${e.channel}` });
    return goto("ingest", input);
  },
});

const ingest = defineStep({
  name: "ingest",
  terminal: true,
  inputSchema: SlackMessageCreated,
  async run(input, ctx) {
    const e = input.event;
    return withDb(ctx, async (db) => {
      await recordRun(db, ctx, AGENT);
      const triageChannel = await getConfig(db, "channels.triage");
      const customer = await customerChannel(db, e.channel);
      const account =
        (await accountByChannel(db, e.channel)) ??
        (await upsertAccount(db, {
          name: customer?.accountName ?? e.channel,
          slackChannelId: e.channel,
        }));

      // A step re-runs from the top on retry: the message row (keyed on the Slack event id) says
      // whether this event already opened an issue.
      const slack = { channel: e.channel, ts: e.ts };
      const linked = await linkMessage(db, {
        source: "slack",
        sourceEventId: input.eventId,
        direction: "customer",
        slack,
        userId: e.user,
        text: e.text,
      });
      let issue = linked.message.issueId
        ? await getIssue(db, linked.message.issueId)
        : null;
      if (!issue) {
        issue = await openIssue(db, {
          accountId: account.id,
          source: "slack",
          category: "other",
          priority: "normal",
          title: titleOf(e.text),
          customer: slack,
        });
        await attachMessage(db, linked.message.id, issue.id);
      }
      await recordRun(db, ctx, AGENT, issue.id);

      if (!issue.triageRootTs) {
        const card = await post(ctx, {
          channel: triageChannel,
          text: issueCardText(issue, account),
          blocks: issueCard(issue, account),
        });
        issue = await setTriageRoot(db, issue.id, card.ts);
        await post(ctx, {
          channel: triageChannel,
          threadTs: card.ts,
          text: `<@${e.user}>: ${e.text}`,
        });
      }

      const receipt = await emit(ctx, db, "issue.created", {
        issueId: issue.id,
        accountId: account.id,
        source: "slack",
        causationId: input.eventId,
        slack,
        category: issue.category ?? "other",
        priority: issue.priority ?? "normal",
        title: issue.title ?? "",
      });
      return terminate({
        issueId: issue.id,
        number: issue.number,
        triageRootTs: issue.triageRootTs,
        receiptId: receipt.receiptId,
        outcome: receipt.outcome,
        duplicate: receipt.duplicate,
      });
    });
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Sylon E2 smoke: a customer-channel message becomes an issue row, a triage card, and an issue.created event.",
  entry: "guard",
  steps: { guard, ingest },
});
