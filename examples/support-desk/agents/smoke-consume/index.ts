/**
 * smoke-consume: the E2 walking skeleton's back half. Started by `issue.created`, it records its
 * run against the issue, which proves an emitted domain event starts a second agent.
 *
 * Trigger: event `issue.created`.
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";

import { agentSlug } from "../../_shared/fleet-id";
import { withDb } from "../../_shared/db";
import { Events } from "../../_shared/events";
import { getIssue, recordRun } from "../../_shared/issues";

export const AGENT = agentSlug("smoke-consume");

const record = defineStep({
  name: "record",
  terminal: true,
  inputSchema: Events["issue.created"],
  async run(input, ctx) {
    return withDb(ctx, async (db) => {
      await recordRun(db, ctx, AGENT, input.issueId);
      const issue = await getIssue(db, input.issueId).catch(() => null);
      ctx.logger.info("received issue.created", {
        issueId: input.issueId,
        causationId: input.causationId,
        found: !!issue,
      });
      return terminate({
        issueId: input.issueId,
        number: issue?.number ?? null,
        status: issue?.status ?? null,
        executionId: ctx.executionId,
      });
    });
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Support desk E2 smoke: consumes issue.created and records its run against the issue.",
  entry: "record",
  steps: { record },
});
