/**
 * urgent-pager: on `issue.created` with priority `urgent`, DM the on-call user (`oncall.slack_id`)
 * the issue title and a link to its triage thread. The live-added agent: one deploy and one
 * trigger (`pnpm run setup --only urgent-pager`), and no other agent changes.
 *
 * Trigger: event `issue.created`.
 *
 * The DM is stored in `messages` under `urgent-pager:<issueId>`, with no issue (it is not in the
 * issue's thread), so a retried run sees it and pages once.
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";

import { escapeMrkdwn, slackToPlain } from "../../_shared/blocks";
import { getConfig } from "../../_shared/config";
import { withDb } from "../../_shared/db";
import { Events } from "../../_shared/events";
import {
  getIssue,
  linkMessage,
  messageBySourceEventId,
  recordRun,
} from "../../_shared/issues";
import { permalink, post } from "../../_shared/slack";

export const AGENT = "sylon-urgent-pager";

export const pageKey = (issueId: string) => `urgent-pager:${issueId}`;

const page = defineStep({
  name: "page",
  terminal: true,
  inputSchema: Events["issue.created"],
  async run(input, ctx) {
    if (input.priority !== "urgent")
      return terminate({ outcome: "not_urgent", priority: input.priority });
    return withDb(ctx, async (db) => {
      await recordRun(db, ctx, AGENT, input.issueId);
      if (await messageBySourceEventId(db, pageKey(input.issueId)))
        return terminate({ outcome: "already_paged" });
      const oncall = await getConfig(db, "oncall.slack_id");
      // A local trace's fresh database lacks the fixture's issue; link the customer message then.
      const issue = await getIssue(db, input.issueId).catch(() => null);
      const link = issue?.triageRootTs
        ? permalink(await getConfig(db, "channels.triage"), issue.triageRootTs)
        : permalink(input.slack.channel, input.slack.ts, input.slack.threadTs);
      const number = issue ? ` #${issue.number}` : "";
      const text = `:rotating_light: Urgent issue${number}: ${escapeMrkdwn(slackToPlain(input.title))}\n${link}`;
      const dm = await post(ctx, { channel: oncall, text });
      await linkMessage(db, {
        source: "slack",
        sourceEventId: pageKey(input.issueId),
        direction: "internal",
        slack: { channel: dm.channel, ts: dm.ts },
        userId: AGENT,
        text,
      });
      return terminate({ outcome: "paged", oncall, ts: dm.ts, link });
    });
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Sylon urgent-pager: on issue.created with priority urgent, DMs the on-call user the title and a triage link.",
  entry: "page",
  steps: { page },
});
