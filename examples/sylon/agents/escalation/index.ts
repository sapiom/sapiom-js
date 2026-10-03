/**
 * escalation: on `issue.escalate`, open one Linear issue for the Sylon issue, record it on the
 * issue, reply "Tracked as SAP-n: <url>" in the customer and triage threads, emit `issue.on_hold`,
 * and move the issue On Hold.
 *
 * Trigger: event `issue.escalate`.
 *
 * One Linear issue per Sylon issue, and one reply per thread:
 * - Check, create, record and both replies run in one transaction holding the issue row lock, so
 *   a concurrent second run waits, then sees the link and the stored reply keys.
 * - Each Linear issue's description starts with `sylon:<issueId>`. With no link recorded, the run
 *   looks for that marker among the project's issues of the last 7 days before creating, so a
 *   retry after Linear created the issue but before the commit adopts it instead of opening a
 *   second.
 * - Replies are keyed in `messages`, so a retry posts only what was not recorded. An issue that is
 *   linked, has its customer reply, and is On Hold (or Closed) is already escalated: the run
 *   replies with the existing identifier in triage and emits nothing.
 * - The move to On Hold and the `issue.on_hold` emit share a second locked transaction: a failed
 *   emit rolls the move back, and a closed or already On Hold issue emits nothing.
 * - Every run that ends with the issue linked redraws the triage card from the row.
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

import { issueCard, issueCardText } from "../../_shared/blocks";
import { MissingConfigError } from "../../_shared/config";
import { deskForIssue, linearTarget } from "../../_shared/desks";
import { withDb, type Db, type DbCtx } from "../../_shared/db";
import { emit, type EmitCtx } from "../../_shared/emit";
import { Events } from "../../_shared/events";
import {
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
import { resolution } from "../linear-sync/rules";
import { permalink, post, update, userInfo } from "../../_shared/slack";

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

/**
 * The reply keys for the issue's current Linear link. The first link uses the bare keys; a link
 * made after an earlier one resolved (a repeat escalation) adds its identifier, so its replies are
 * not mistaken for the first escalation's.
 */
async function replyKeys(db: Db, issueId: string, identifier: string) {
  const first = await messageBySourceEventId(db, customerReplyKey(issueId));
  const text = first?.text ?? "";
  const bare =
    !first ||
    text.includes(`Tracked as ${identifier}:`) ||
    text.endsWith(`Tracked as ${identifier}`);
  const suffix = bare ? "" : `:${identifier}`;
  return {
    customer: `${customerReplyKey(issueId)}${suffix}`,
    triage: `${triageReplyKey(issueId)}${suffix}`,
  };
}

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
  /** The clicker: Slack user id, and display name when known. */
  requestedBy: { id: string; name?: string };
  threadUrl: string | null;
}): string {
  return [
    // First, so it falls inside the description preview `list_issues` returns.
    `Sylon issue #${input.issue.number} · ${marker(input.issue.id)}`,
    "",
    `**Account:** ${input.accountName}`,
    `**Requested by:** ${
      input.requestedBy.name && input.requestedBy.name !== input.requestedBy.id
        ? `${input.requestedBy.name} (${input.requestedBy.id})`
        : `Slack user ${input.requestedBy.id}`
    }`,
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
  const desk = await deskForIssue(db, await getIssue(db, issueId));
  const target = await linearTarget(db, desk);
  if (!target)
    throw new MissingConfigError(`desks.${desk.slug}.linearProjectId`);
  const { teamId, projectId } = target;
  const triageChannel = desk.triageChannel;
  const requester = await userInfo(ctx, input.requestedBy);

  // 1. Link and reply, under the row lock: a concurrent run waits here, then finds the link and
  // the stored reply keys, so it neither creates nor posts.
  const linked = await db.transaction(async (tx) => {
    let issue = await lockIssue(tx, issueId);
    let made: "existing" | "adopted" | "created" = "existing";
    let url = "";
    // A repeat escalation of an issue whose Linear issue is already Done or Canceled gets a new
    // Linear issue, so engineering sees the new report; the resolved one would only bounce it back.
    const resolved =
      issue.linearIdentifier &&
      issue.status !== "on_hold" &&
      resolution(
        await getLinearIssue(
          ctx,
          issue.linearIssueId ?? issue.linearIdentifier,
        ),
      ) !== null;
    if (!issue.linearIssueId || !issue.linearIdentifier || resolved) {
      const account = await getAccount(tx, issue.accountId);
      const found = resolved
        ? null
        : await findByMarker(ctx, { teamId, projectId, issueId });
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
            requestedBy: { id: requester.id, name: requester.name },
            threadUrl: threadUrl(issue),
          }),
          priority: issue.priority
            ? LINEAR_PRIORITY[issue.priority]
            : undefined,
          links: threadUrl(issue)
            ? [{ url: threadUrl(issue)!, title: "Customer thread (Slack)" }]
            : undefined,
        }));
      issue = await updateIssue(tx, issueId, {
        linearIssueId: linear.id,
        linearIdentifier: linear.identifier,
        linearUrl: linear.url || undefined,
      });
      made = found ? "adopted" : "created";
      url = linear.url;
    }
    const identifier = issue.linearIdentifier!;
    url = url || issue.linearUrl || (await getLinearIssue(ctx, identifier)).url;
    // An issue linked before 050_linear_url gets its URL now, so the redrawn card can link it.
    if (url && !issue.linearUrl)
      issue = await updateIssue(tx, issueId, { linearUrl: url });
    url ||= `(no url for ${identifier})`;
    const base = { issueId, linearIdentifier: identifier, url, made };

    const keys = await replyKeys(tx, issueId, identifier);
    const replied = await messageBySourceEventId(tx, keys.customer);
    if (
      made === "existing" &&
      replied &&
      (issue.status === "on_hold" || issue.status === "closed")
    ) {
      await replyOnce(ctx, tx, {
        key: `escalation:${issueId}:${input.causationId}`,
        channel: triageChannel,
        threadTs: issue.triageRootTs,
        text: `Already tracked as ${identifier}: ${url}`,
        direction: "internal",
        issueId,
      });
      return { issue, base, already: true as const };
    }

    const text = `Tracked as ${identifier}: ${url}`;
    const triageTs = await replyOnce(ctx, tx, {
      key: keys.triage,
      channel: triageChannel,
      threadTs: issue.triageRootTs,
      text,
      direction: "internal",
      issueId,
    });
    const customerTs = await replyOnce(ctx, tx, {
      key: keys.customer,
      channel: issue.customerChannel ?? input.slack.channel,
      threadTs: issue.customerRootTs,
      text,
      direction: "agent",
      issueId,
    });
    return { issue, base, already: false as const, triageTs, customerTs };
  });

  if (linked.already) {
    await redrawCard(ctx, db, triageChannel, linked.issue);
    return {
      ...linked.base,
      outcome: "already_escalated",
      status: linked.issue.status,
    };
  }
  const replies = { triageTs: linked.triageTs, customerTs: linked.customerTs };

  // 2. Status, then emit, in one locked transaction: a failed emit rolls the status move back, so
  // On Hold means the event went out. A run that finds the issue already On Hold (a concurrent
  // run got here first) or closed emits nothing.
  const parked = await db.transaction(async (tx) => {
    const issue = await lockIssue(tx, issueId);
    if (issue.status === "closed" || issue.status === "on_hold")
      return { issue, receipt: null };
    const moved = await setStatus(tx, issueId, "on_hold");
    const receipt = await emit(ctx, tx, "issue.on_hold", {
      issueId,
      accountId: moved.accountId,
      source: "slack",
      causationId: input.causationId,
      slack: input.slack,
      linearIdentifier: moved.linearIdentifier!,
    });
    return { issue: moved, receipt };
  });

  await redrawCard(ctx, db, triageChannel, parked.issue);
  if (parked.issue.status === "closed") {
    // closed → on_hold is not a legal move; the link and replies stand, and the output says so.
    return {
      ...linked.base,
      ...replies,
      outcome: "linked_closed",
      status: parked.issue.status,
      note: "issue is closed; linked to Linear but not moved to on_hold",
    };
  }
  if (!parked.receipt) {
    return {
      ...linked.base,
      ...replies,
      outcome: "already_escalated",
      status: parked.issue.status,
    };
  }
  return {
    ...linked.base,
    ...replies,
    outcome: "escalated",
    status: parked.issue.status,
    receiptId: parked.receipt.receiptId,
    duplicate: parked.receipt.duplicate,
  };
}

/** Redraw the triage card from the row; the card is a pure function of the issue and its account. */
async function redrawCard(
  ctx: Ctx,
  db: Db,
  triageChannel: string,
  issue: Issue,
): Promise<void> {
  if (!issue.triageRootTs) return;
  const account = await getAccount(db, issue.accountId);
  await update(ctx, {
    channel: triageChannel,
    ts: issue.triageRootTs,
    text: issueCardText(issue, account),
    blocks: issueCard(issue, account),
  });
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
