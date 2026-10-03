/**
 * linear-sync: the cron that brings an escalated issue back when engineering finishes with it.
 * Each run reads the Linear state of the On Hold issues that have a Linear link; when the Linear
 * issue is Done or Canceled, it posts in the triage thread, moves the Sylon issue to On You, and
 * for Done emits `issue.engineering_resolved`. With `linear_sync.notify_customer` on, a Done also
 * tells the customer; it defaults to off so a shadow install never shows customers anything.
 *
 * Trigger: `schedule_cron` (`*\/2 * * * *` in fleet.json). The stored `input` may carry `limit`.
 *
 * Reads are capped per run (`READ_CAP`), least recently checked first (`linear_checked_at`), so a
 * large backlog rotates instead of starving. A Linear error on one issue is logged and the run
 * goes on with the rest.
 *
 * Idempotent across retries and overlapping runs, under the issue row lock:
 * - Posts are keyed in `messages` (`linear-sync:<issueId>:<identifier>:<on_hold_at>:<done|canceled>`,
 *   the customer message with `:customer`), each committed in its own transaction before the move,
 *   so a retry after a failed move or a failed later post posts nothing twice. `on_hold_at` is the
 *   escalation generation: a repeat escalation of the issue gets fresh keys. With no triage
 *   thread the notice goes top-level in the triage channel.
 * - The move, the emit and `card_dirty` share a locked transaction: a failed emit rolls the move
 *   back, and an issue that is no longer On Hold is left alone, so a second run does nothing.
 *   `card_dirty` is cleared after the card redraw; every tick first redraws the dirty cards.
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

import {
  issueCard,
  issueCardText,
  mrkdwnLink,
  escapeMrkdwn,
} from "../../_shared/blocks";
import { getConfig, getConfigOr } from "../../_shared/config";
import { withDb, type Db, type DbCtx } from "../../_shared/db";
import { emit, type EmitCtx } from "../../_shared/emit";
import {
  getAccount,
  linkMessage,
  lockIssue,
  cardDirty,
  markLinearChecked,
  messageBySourceEventId,
  onHoldLinked,
  recordRun,
  setCardDirty,
  setStatus,
  type Direction,
  type Issue,
} from "../../_shared/issues";
import { getIssue as getLinearIssue } from "../../_shared/linear";
import { post, update } from "../../_shared/slack";

import { resolution, syncKey, type Resolution } from "./rules";

export const AGENT = "sylon-linear-sync";

/** Linear reads per run; the least recently checked issues go first. */
export const READ_CAP = 25;

export const CUSTOMER_MESSAGE =
  "Our engineering team has shipped a fix for this. Let us know if you still see the problem.";

const Input = z.object({
  limit: z.number().int().positive().max(READ_CAP).optional(),
});

type Ctx = DbCtx & EmitCtx;

export interface Resolved {
  issueId: string;
  linearIdentifier: string;
  resolution: Resolution;
}

/** Post once per key: a committed row means the post went out. Returns false when it already had. */
async function postOnce(
  ctx: Ctx,
  db: Db,
  input: {
    key: string;
    issueId: string;
    channel: string | null;
    threadTs: string | null;
    text: string;
    direction: Direction;
  },
): Promise<boolean> {
  if (await messageBySourceEventId(db, input.key)) return false;
  if (!input.channel) {
    ctx.logger.warn("no channel to post in; skipped", { key: input.key });
    return false;
  }
  const posted = await post(ctx, {
    channel: input.channel,
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
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
      threadTs: input.threadTs ?? undefined,
    },
    userId: AGENT,
    text: input.text,
  });
  return true;
}

function triageText(url: string, r: Resolution, identifier: string): string {
  const id = escapeMrkdwn(identifier);
  const link = url ? mrkdwnLink(url, id) : id;
  return r === "done"
    ? `Engineering marked ${link} Done. Reply to the customer.`
    : `${link} was canceled in Linear.`;
}

/**
 * Act on one Linear issue that reached a terminal state. Returns the moved issue, or null when
 * the issue was no longer On Hold (another run got here first, or someone moved it).
 */
export async function resolveIssue(
  ctx: Ctx,
  db: Db,
  triageChannel: string,
  input: {
    issueId: string;
    identifier: string;
    url: string;
    state: string;
    resolution: Resolution;
  },
): Promise<Issue | null> {
  const notifyCustomer =
    input.resolution === "done" &&
    (await getConfigOr(db, "linear_sync.notify_customer", false));

  // 1. Each post is its own committed write, so a later failed post or move never rolls back the
  // record of one that went out. With no triage thread the notice goes top-level in the channel.
  const key = await db.transaction(async (tx) => {
    const issue = await lockIssue(tx, input.issueId);
    if (issue.status !== "on_hold") return null;
    const k = syncKey(
      input.issueId,
      input.identifier,
      input.resolution,
      issue.onHoldAt?.getTime() ?? 0,
    );
    await postOnce(ctx, tx, {
      key: k,
      issueId: issue.id,
      channel: triageChannel,
      threadTs: issue.triageRootTs,
      text: triageText(
        issue.linearUrl ?? input.url,
        input.resolution,
        input.identifier,
      ),
      direction: "internal",
    });
    return k;
  });
  if (!key) return null;
  if (notifyCustomer) {
    await db.transaction(async (tx) => {
      const issue = await lockIssue(tx, input.issueId);
      if (issue.status !== "on_hold") return;
      await postOnce(ctx, tx, {
        key: `${key}:customer`,
        issueId: issue.id,
        channel: issue.customerChannel,
        threadTs: issue.customerRootTs,
        text: CUSTOMER_MESSAGE,
        direction: "agent",
      });
    });
  }

  // 2. Move, then emit, in one locked transaction: a failed emit rolls the move back.
  return db.transaction(async (tx) => {
    const issue = await lockIssue(tx, input.issueId);
    if (issue.status !== "on_hold") return null;
    const moved = await setStatus(tx, input.issueId, "on_you");
    // Committed with the move, so a failed redraw is retried by a later tick.
    await setCardDirty(tx, input.issueId, true);
    if (input.resolution === "done") {
      await emit(ctx, tx, "issue.engineering_resolved", {
        issueId: moved.id,
        accountId: moved.accountId,
        source: "slack",
        causationId: key,
        slack: {
          channel: moved.customerChannel ?? triageChannel,
          ts: moved.customerRootTs ?? moved.triageRootTs ?? "0",
        },
        linearIdentifier: input.identifier,
        linearState: input.state,
      });
    }
    return moved;
  });
}

/** Redraw the triage card from the row; the card is a pure function of the issue and its account. */
async function redrawCard(
  ctx: Ctx,
  db: Db,
  triageChannel: string,
  issue: Issue,
): Promise<void> {
  if (issue.triageRootTs) {
    const account = await getAccount(db, issue.accountId);
    await update(ctx, {
      channel: triageChannel,
      ts: issue.triageRootTs,
      text: issueCardText(issue, account),
      blocks: issueCard(issue, account),
    });
  }
  await setCardDirty(db, issue.id, false);
}

export async function sync(ctx: Ctx, db: Db, limit: number = READ_CAP) {
  await recordRun(db, ctx, AGENT);
  const triageChannel = await getConfig(db, "channels.triage");

  // Cards left stale by a failed redraw on an earlier tick; these issues are no longer On Hold.
  for (const issue of await cardDirty(db, READ_CAP))
    await redrawCard(ctx, db, triageChannel, issue).catch((err) =>
      ctx.logger.warn("card redraw failed", {
        issueId: issue.id,
        err: String(err),
      }),
    );

  const candidates = await onHoldLinked(db, Math.min(limit, READ_CAP));

  const resolved: Resolved[] = [];
  const failed: { issueId: string; error: string }[] = [];
  for (const issue of candidates) {
    const identifier = issue.linearIdentifier!;
    try {
      const linear = await getLinearIssue(
        ctx,
        issue.linearIssueId ?? identifier,
      );
      // Stamped on a failed read too, so one broken issue does not pin the front of the queue.
      await markLinearChecked(db, issue.id);
      const r = resolution(linear);
      if (!r) continue;
      const moved = await resolveIssue(ctx, db, triageChannel, {
        issueId: issue.id,
        identifier,
        url: linear.url,
        state: linear.status ?? linear.statusType ?? "",
        resolution: r,
      });
      if (!moved) continue;
      resolved.push({
        issueId: issue.id,
        linearIdentifier: identifier,
        resolution: r,
      });
      await redrawCard(ctx, db, triageChannel, moved).catch((err) =>
        ctx.logger.warn("card redraw failed", {
          issueId: issue.id,
          err: String(err),
        }),
      );
    } catch (err) {
      await markLinearChecked(db, issue.id).catch(() => undefined);
      ctx.logger.error("linear-sync failed for issue", {
        issueId: issue.id,
        linearIdentifier: identifier,
        err: String(err),
      });
      failed.push({ issueId: issue.id, error: String(err) });
    }
  }
  ctx.logger.info("linear-sync", {
    checked: candidates.length,
    resolved: resolved.length,
    failed: failed.length,
  });
  return { checked: candidates.length, resolved, failed };
}

const syncStep = defineStep({
  name: "sync",
  terminal: true,
  inputSchema: Input,
  async run(input, ctx) {
    return terminate(await withDb(ctx, (db) => sync(ctx, db, input.limit)));
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Sylon linear-sync: a cron that moves On Hold issues back to On You when their Linear issue is Done or Canceled, and emits issue.engineering_resolved on Done.",
  entry: "sync",
  steps: { sync: syncStep },
});
