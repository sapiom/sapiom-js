/**
 * urgent-pager: on `issue.created` with priority `urgent`, DM the issue's desk's on-call user
 * the issue title and a link to its triage thread. The live-added agent: one deploy and one
 * trigger (`pnpm run setup --only urgent-pager`), and no other agent changes.
 *
 * Trigger: event `issue.created`.
 *
 * The DM is stored in `messages` under `urgent-pager:<issueId>`, with no issue (it is not in the
 * issue's thread). The check, the DM and that row share one transaction under the issue's row
 * lock, so a retried or concurrent run pages once. A crash between Slack's 200 and the commit can
 * still page twice (post then record, a known limitation).
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";

import { escapeMrkdwn, slackToPlain } from "../../_shared/blocks";
import { MissingConfigError } from "../../_shared/config";
import {
  deskForIssue,
  oncallFor,
  requireDefaultDesk,
} from "../../_shared/desks";
import { withDb } from "../../_shared/db";
import { Events } from "../../_shared/events";
import {
  linkMessage,
  lockIssue,
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
      // Check, post and record under the issue's row lock: an overlapping run (a redelivery beside
      // a slow first attempt) waits here, then finds the stored page and sends nothing.
      return db.transaction(async (tx) => {
        // A local trace's fresh database lacks the fixture's issue; link the customer message then.
        // The lock is a plain select, so a missing row aborts nothing.
        const issue = await lockIssue(tx, input.issueId).catch(() => null);
        if (await messageBySourceEventId(tx, pageKey(input.issueId)))
          return terminate({ outcome: "already_paged" });
        const desk = issue
          ? await deskForIssue(tx, issue)
          : await requireDefaultDesk(tx);
        const oncall = await oncallFor(tx, desk);
        if (!oncall)
          throw new MissingConfigError(`desks.${desk.slug}.oncallSlackId`);
        const link = issue?.triageRootTs
          ? permalink(desk.triageChannel, issue.triageRootTs)
          : permalink(
              input.slack.channel,
              input.slack.ts,
              input.slack.threadTs,
            );
        const number = issue ? ` #${issue.number}` : "";
        const text = `:rotating_light: Urgent issue${number}: ${escapeMrkdwn(slackToPlain(input.title))}\n${link}`;
        const dm = await post(ctx, { channel: oncall, text });
        await linkMessage(tx, {
          source: "slack",
          sourceEventId: pageKey(input.issueId),
          direction: "internal",
          slack: { channel: dm.channel, ts: dm.ts },
          userId: AGENT,
          text,
        });
        return terminate({ outcome: "paged", oncall, ts: dm.ts, link });
      });
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
