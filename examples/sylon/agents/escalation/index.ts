/**
 * escalation: on `issue.escalate`, open one Linear issue for the Sylon issue, record it on the
 * issue, reply "Tracked as SAP-n: <url>" in the customer and triage threads, emit `issue.on_hold`,
 * and move the issue On Hold.
 *
 * Trigger: event `issue.escalate`.
 *
 * One Linear issue per Sylon issue:
 * - Check, create and record run in one transaction holding the issue row lock, so a concurrent
 *   second run waits, then sees the link.
 * - Each Linear issue's description starts with `sylon:<issueId>`. With no link recorded, the run
 *   looks for that marker among the project's issues of the last 7 days before creating, so a
 *   retry after Linear created the issue but before the commit adopts it instead of opening a
 *   second.
 * - The tail (replies, emit, status) is idempotent: replies are keyed in `messages`, the emit
 *   dedups on its id, and the status move is a no-op when repeated. An issue that is linked, has
 *   its customer reply, and is On Hold (or Closed) is already escalated: the run replies with the
 *   existing identifier in triage and emits nothing.
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

import { getConfig } from "../../_shared/config";
import { withDb, type Db, type DbCtx } from "../../_shared/db";
import { emit, type EmitCtx } from "../../_shared/emit";
import { Events } from "../../_shared/events";
import {
  IllegalTransitionError,
  accountByChannel,
  ensureAccount,
  getAccount,
  getIssue,
  issueByCustomerThread,
  linkMessage,
  lockIssue,
  messageBySourceEventId,
  openIssue,
  recordRun,
  setStatus,
  updateIssue,
  type Direction,
  type Issue,
} from "../../_shared/issues";
import {
  callTool,
  createIssue,
  getIssue as getLinearIssue,
  toLinearIssue,
  type LinearIssue,
} from "../../_shared/linear";
import { permalink, post } from "../../_shared/slack";

export const AGENT = "sylon-escalation";

/** Linear MCP tool used to find an issue a crashed attempt already created. */
export const LIST_ISSUES_TOOL = "list_issues";

/** Sylon priority → Linear priority (1 urgent, 2 high, 3 medium, 4 low). */
export const LINEAR_PRIORITY: Record<string, number> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
};

/** Written into every Linear description; the key a retry searches for. */
export const marker = (issueId: string) => `sylon:${issueId}`;

/** Key of the customer-thread reply in `messages`; its presence means the replies went out. */
export const customerReplyKey = (issueId: string) => `escalation:${issueId}`;
const triageReplyKey = (issueId: string) => `escalation:${issueId}:triage`;

export const EscalateInput = Events["issue.escalate"].extend({
  /**
   * Local traces only: the issue to seed when the payload's issue is not in the trace's fresh
   * database. `linearIdentifier` seeds it as already escalated. Ignored by a deployed run.
   */
  localSeed: z
    .object({
      status: z.enum(["new", "on_you", "closed"]).optional(),
      linearIdentifier: z.string().optional(),
    })
    .optional(),
});
export type EscalateInput = z.infer<typeof EscalateInput>;

type Ctx = DbCtx & EmitCtx;

export function linearDescription(input: {
  issue: Issue;
  accountName: string;
  summary: string;
  requestedBy: string;
  threadUrl: string | null;
}): string {
  return [
    // First, so it falls inside the description preview `list_issues` returns.
    `Sylon issue #${input.issue.number} · ${marker(input.issue.id)}`,
    "",
    `**Account:** ${input.accountName}`,
    `**Requested by:** Slack user ${input.requestedBy}`,
    "",
    input.summary,
    "",
    input.threadUrl
      ? `[Customer thread in Slack](${input.threadUrl})`
      : "(no customer thread)",
  ].join("\n");
}

/** How far back a retry looks for an issue a crashed attempt created. */
export const MARKER_LOOKBACK = "-P7D";

/**
 * A Linear issue in the project whose description carries the marker, if a crashed attempt made
 * one. Lists the project's recent issues and matches the marker in the description preview,
 * rather than `query`: Linear's search is fuzzy (an unknown uuid matches unrelated issues) and
 * indexed, so a just-created issue might not be found.
 */
export async function findByMarker(
  ctx: Ctx,
  input: { teamId: string; projectId: string; issueId: string },
): Promise<LinearIssue | null> {
  if (ctx.isLocalTrace) return null;
  const out = (await callTool(LIST_ISSUES_TOOL, {
    team: input.teamId,
    project: input.projectId,
    createdAt: MARKER_LOOKBACK,
    orderBy: "createdAt",
    includeArchived: true,
    limit: 250,
  })) as { issues?: Record<string, unknown>[] };
  const hit = (out.issues ?? []).find(
    (r) =>
      typeof r.description === "string" &&
      r.description.includes(marker(input.issueId)),
  );
  return hit ? toLinearIssue(hit) : null;
}

/** Post once per key: a retried step finds the stored row and does not post again. */
async function replyOnce(
  ctx: Ctx,
  db: Db,
  input: {
    key: string;
    channel: string;
    threadTs: string | null;
    text: string;
    direction: Direction;
    issueId?: string;
  },
): Promise<string | null> {
  const stored = await messageBySourceEventId(db, input.key);
  if (stored) return stored.ts;
  if (!input.threadTs) {
    ctx.logger.warn("no thread to reply in; skipped", { key: input.key });
    return null;
  }
  const posted = await post(ctx, {
    channel: input.channel,
    threadTs: input.threadTs,
    text: input.text,
  });
  await linkMessage(db, {
    issueId: input.issueId,
    source: "slack",
    sourceEventId: input.key,
    direction: input.direction,
    slack: {
      channel: posted.channel,
      ts: posted.ts,
      threadTs: input.threadTs,
    },
    userId: AGENT,
    text: input.text,
  });
  return posted.ts;
}

/**
 * A local trace starts from an empty database, so the fixture's issue does not exist: open one in
 * the payload's customer thread (with a stand-in triage root), or reuse the one an earlier step of
 * this trace opened, and return its id.
 */
async function seedLocalIssue(db: Db, input: EscalateInput): Promise<string> {
  const found =
    (await getIssue(db, input.issueId).catch(() => null)) ??
    (await issueByCustomerThread(
      db,
      input.slack.channel,
      input.slack.threadTs ?? input.slack.ts,
    ));
  if (found) return found.id;
  const account =
    (await accountByChannel(db, input.slack.channel)) ??
    (await ensureAccount(db, {
      name: input.slack.channel,
      slackChannelId: input.slack.channel,
    }));
  const issue = await openIssue(db, {
    accountId: account.id,
    source: "slack",
    category: "bug",
    priority: "high",
    title: "[local] Inbound events fail after retry",
    customer: input.slack,
    triageRootTs: "1790000000.000001",
  });
  const seed = input.localSeed;
  if (seed?.status) await setStatus(db, issue.id, seed.status);
  if (seed?.linearIdentifier) {
    await updateIssue(db, issue.id, {
      linearIssueId: "00000000-0000-4000-8000-00000000c0de",
      linearIdentifier: seed.linearIdentifier,
    });
    await linkMessage(db, {
      issueId: issue.id,
      source: "slack",
      sourceEventId: customerReplyKey(issue.id),
      direction: "agent",
      slack: { channel: input.slack.channel, ts: "1790000000.000002" },
      userId: AGENT,
      text: `Tracked as ${seed.linearIdentifier}`,
    });
    if (seed.status !== "closed") await setStatus(db, issue.id, "on_hold");
  }
  return issue.id;
}

export async function escalate(ctx: Ctx, db: Db, input: EscalateInput) {
  const issueId = ctx.isLocalTrace
    ? await seedLocalIssue(db, input)
    : input.issueId;
  await recordRun(db, ctx, AGENT, issueId);
  const teamId = await getConfig(db, "linear.team_id");
  const projectId = await getConfig(db, "linear.project_id");
  const triageChannel = await getConfig(db, "channels.triage");

  const link = await db.transaction(async (tx) => {
    const issue = await lockIssue(tx, issueId);
    if (issue.linearIssueId && issue.linearIdentifier)
      return { issue, linear: null, made: "existing" as const };
    const account = await getAccount(tx, issue.accountId);
    const found = await findByMarker(ctx, { teamId, projectId, issueId });
    const linear =
      found ??
      (await createIssue(ctx, {
        teamId,
        projectId,
        title: issue.title || `Sylon #${issue.number}`,
        description: linearDescription({
          issue,
          accountName: account.name,
          summary: input.summary,
          requestedBy: input.requestedBy,
          threadUrl: threadUrl(issue),
        }),
        priority: issue.priority ? LINEAR_PRIORITY[issue.priority] : undefined,
        links: threadUrl(issue)
          ? [{ url: threadUrl(issue)!, title: "Customer thread (Slack)" }]
          : undefined,
      }));
    const recorded = await updateIssue(tx, issueId, {
      linearIssueId: linear.id,
      linearIdentifier: linear.identifier,
    });
    return {
      issue: recorded,
      linear,
      made: found ? ("adopted" as const) : ("created" as const),
    };
  });

  let issue = link.issue;
  const identifier = issue.linearIdentifier!;
  const url =
    link.linear?.url ||
    (await getLinearIssue(ctx, identifier)).url ||
    `(no url for ${identifier})`;
  const text = `Tracked as ${identifier}: ${url}`;
  const base = { issueId, linearIdentifier: identifier, url, made: link.made };

  const replied = await messageBySourceEventId(db, customerReplyKey(issueId));
  if (
    link.made === "existing" &&
    replied &&
    (issue.status === "on_hold" || issue.status === "closed")
  ) {
    await replyOnce(ctx, db, {
      key: `escalation:${issueId}:${input.causationId}`,
      channel: triageChannel,
      threadTs: issue.triageRootTs,
      text: `Already tracked as ${identifier}: ${url}`,
      direction: "internal",
    });
    return { ...base, outcome: "already_escalated", status: issue.status };
  }

  const triageTs = await replyOnce(ctx, db, {
    key: triageReplyKey(issueId),
    channel: triageChannel,
    threadTs: issue.triageRootTs,
    text,
    direction: "internal",
  });
  const customerTs = await replyOnce(ctx, db, {
    key: customerReplyKey(issueId),
    channel: issue.customerChannel ?? input.slack.channel,
    threadTs: issue.customerRootTs,
    text,
    direction: "agent",
    issueId,
  });
  const replies = { triageTs, customerTs };

  if (issue.status === "closed") {
    // closed → on_hold is not a legal move; the link and replies stand, and the output says so.
    return {
      ...base,
      ...replies,
      outcome: "linked_closed",
      status: issue.status,
      note: "issue is closed; linked to Linear but not moved to on_hold",
    };
  }

  // Emit before the status move: a retry after the emit re-sends the same id (deduped), while
  // an issue already On Hold would be read as finished and lose its event.
  const receipt = await emit(ctx, db, "issue.on_hold", {
    issueId,
    accountId: issue.accountId,
    source: "slack",
    causationId: input.causationId,
    slack: input.slack,
    linearIdentifier: identifier,
  });
  try {
    issue = await setStatus(db, issueId, "on_hold");
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) throw err;
    // Closed between the lock and here.
    return {
      ...base,
      ...replies,
      outcome: "linked_closed",
      status: err.from,
      receiptId: receipt.receiptId,
      note: "issue was closed during escalation; not moved to on_hold",
    };
  }
  return {
    ...base,
    ...replies,
    outcome: "escalated",
    status: issue.status,
    receiptId: receipt.receiptId,
    duplicate: receipt.duplicate,
  };
}

function threadUrl(issue: Issue): string | null {
  return issue.customerChannel && issue.customerRootTs
    ? permalink(issue.customerChannel, issue.customerRootTs)
    : null;
}

const escalateStep = defineStep({
  name: "escalate",
  terminal: true,
  inputSchema: EscalateInput,
  async run(input, ctx) {
    return terminate(await withDb(ctx, (db) => escalate(ctx, db, input)));
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Sylon escalation: on issue.escalate, opens one Linear issue, replies 'Tracked as SAP-n' in both threads, emits issue.on_hold, and moves the issue On Hold.",
  entry: "escalate",
  steps: { escalate: escalateStep },
});
