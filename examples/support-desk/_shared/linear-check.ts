/**
 * Bring an escalated (On Hold) issue back when engineering is done with it. Three paths reach it:
 * - the controller's tick for an On Hold issue reads its Linear issue on a backoff
 *   ({@link nextLinearCheck}: 1 h after it went On Hold, 4 h after that, then daily);
 * - intake reads it when a customer message lands on the On Hold issue;
 * - a person clicks Resolved on the issue card or in the Console (`resolveByHand`).
 *
 * When the Linear issue is Done or Canceled, or someone clicks Resolved, the issue posts in the
 * triage thread, moves to On You, and (Done and Resolved) emits `issue.engineering_resolved`. With
 * `linear_sync.notify_customer` on, a Done also tells the customer; it defaults to off so a shadow
 * install never shows customers anything.
 *
 * Idempotent across retries and overlapping runs, under the issue row lock:
 * - Posts are keyed in `messages` (`linear-sync:<issueId>:<identifier>:<on_hold_at>:<done|canceled|resolved>`,
 *   the customer message with `:customer`), each committed in its own transaction before the move,
 *   so a retry after a failed move or a failed later post posts nothing twice. `on_hold_at` is the
 *   escalation generation: a repeat escalation of the issue gets fresh keys. With no triage
 *   thread the notice goes top-level in the triage channel. The `linear-sync:` prefix predates
 *   this file and stays, so an install's recorded keys keep deduping.
 * - The move, the emit and `card_dirty` share a locked transaction: a failed emit rolls the move
 *   back, and an issue that is no longer On Hold is left alone, so a second run does nothing.
 *   `card_dirty` is cleared after the card redraw; the controller's next tick for the issue
 *   retries a failed one.
 */
import { escapeMrkdwn, issueCard, issueCardText, mrkdwnLink } from "./blocks";
import { getConfigFresh } from "./config";
import type { Db, DbCtx } from "./db";
import { deskForIssue } from "./desks";
import { emit, type EmitCtx } from "./emit";
import {
  getAccount,
  linkMessage,
  lockIssue,
  markLinearChecked,
  messageBySourceEventId,
  setCardDirty,
  setStatus,
  type Direction,
  type Issue,
} from "./issues";
import { getIssue as getLinearIssue, type LinearIssue } from "./linear";
import { issueSla } from "./sla";
import { post, update } from "./slack";

export type Resolution = "done" | "canceled" | "resolved";

export const CUSTOMER_MESSAGE =
  "Our engineering team has shipped a fix for this. Let us know if you still see the problem.";

/** The On Hold check's backoff, from when the issue went On Hold: after 1 h, 4 h later, then daily. */
export const LINEAR_CHECK_MINUTES = [60, 240, 1440] as const;

type Ctx = DbCtx & EmitCtx;

/**
 * `get_issue` returns `statusType` (Linear's workflow state type: triage, backlog, unstarted,
 * started, completed, canceled) beside the team-specific `status` name. The type is authoritative;
 * the name is read only when a reply carries no type.
 */
export function resolution(
  linear: Pick<LinearIssue, "status" | "statusType">,
): Exclude<Resolution, "resolved"> | null {
  const type = linear.statusType?.toLowerCase();
  if (type === "completed") return "done";
  if (type === "canceled" || type === "cancelled") return "canceled";
  if (type) return null;
  const name = linear.status?.toLowerCase();
  if (name === "done") return "done";
  if (name === "canceled" || name === "cancelled") return "canceled";
  return null;
}

/**
 * Key of the triage post for one resolution of one Linear issue; the base of every dedup key.
 * `generation` is the issue's `on_hold_at` (epoch ms), so each escalation of the same issue is keyed apart.
 */
export const syncKey = (
  issueId: string,
  identifier: string,
  r: Resolution,
  generation: number,
): string => `linear-sync:${issueId}:${identifier}:${generation}:${r}`;

/**
 * When the On Hold issue's Linear issue should next be read: the first point of the backoff
 * (counted from `onHoldAt`) after the last read, or the first point when it was never read since
 * it went On Hold. A read for another reason (a customer message) moves the next one only when it
 * passes a point.
 */
export function nextLinearCheck(onHoldAt: Date, checkedAt: Date | null): Date {
  const start = onHoldAt.getTime();
  const last =
    checkedAt && checkedAt.getTime() > start ? checkedAt.getTime() : start;
  const [first, second, daily] = LINEAR_CHECK_MINUTES.map((m) => m * 60_000);
  let at = start + first;
  if (at > last) return new Date(at);
  at += second;
  if (at > last) return new Date(at);
  // The daily points after the second: the first one past `last`.
  const days = Math.floor((last - at) / daily) + 1;
  return new Date(at + days * daily);
}

/** When the issue's Linear issue is next due a read, or null when it is not On Hold with a link. */
export function linearCheckDue(
  issue: Pick<
    Issue,
    "status" | "linearIdentifier" | "onHoldAt" | "updatedAt" | "linearCheckedAt"
  >,
): Date | null {
  if (issue.status !== "on_hold" || !issue.linearIdentifier) return null;
  return nextLinearCheck(
    issue.onHoldAt ?? issue.updatedAt,
    issue.linearCheckedAt,
  );
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
    userId: string;
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
    key: input.key,
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
    userId: input.userId,
    text: input.text,
  });
  return true;
}

function triageText(
  url: string,
  r: Resolution,
  identifier: string,
  by: string | null,
): string {
  const id = escapeMrkdwn(identifier);
  const link = url ? mrkdwnLink(url, id) : id;
  if (r === "resolved")
    return `Marked resolved by <@${by}>${identifier ? ` (${link})` : ""}. Reply to the customer.`;
  return r === "done"
    ? `Engineering marked ${link} Done. Reply to the customer.`
    : `${link} was canceled in Linear.`;
}

/**
 * Act on an On Hold issue whose Linear issue reached a terminal state, or that someone marked
 * resolved (`resolution: "resolved"`, `by` the clicker). Returns the moved issue, or null when the
 * issue was no longer On Hold (another run got here first, or someone moved it).
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
    /** The agent slug, or the Slack user who clicked Resolved. */
    by: string;
  },
): Promise<Issue | null> {
  const notifyCustomer =
    input.resolution === "done" &&
    (await getConfigFresh(db, "linear_sync.notify_customer", false));
  const clicker = input.resolution === "resolved" ? input.by : null;

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
        clicker,
      ),
      direction: "internal",
      userId: input.by,
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
        userId: input.by,
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
    if (input.resolution !== "canceled") {
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

/** Recompute the SLA clock before redrawing so the card reflects current targets and thread history. */
export async function redrawCard(
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
      blocks: issueCard(issue, account, await issueSla(db, issue)),
    });
  }
  await setCardDirty(db, issue.id, false);
}

/** Redraw a card left stale by a failed redraw. Never throws: the next tick tries again. */
export async function redrawIfDirty(
  ctx: Ctx,
  db: Db,
  issue: Issue,
): Promise<void> {
  if (!issue.cardDirty) return;
  try {
    const channel =
      issue.triageChannel ?? (await deskForIssue(db, issue)).triageChannel;
    await redrawCard(ctx, db, channel, issue);
  } catch (err) {
    ctx.logger.warn("card redraw failed", {
      issueId: issue.id,
      err: String(err),
    });
  }
}

export interface LinearCheck {
  issueId: string;
  linearIdentifier: string;
  /** The Linear state read, or null when the read failed. */
  state: string | null;
  /** Set when the issue left On Hold on this read. */
  resolution: Resolution | null;
  error?: string;
}

/**
 * Read the On Hold issue's Linear issue and act on a terminal state. An error is logged and
 * returned, never thrown, so the caller (a tick, or intake on a customer message) carries on with
 * its own work.
 */
export async function checkLinear(
  ctx: Ctx,
  db: Db,
  issue: Issue,
  by: string,
): Promise<LinearCheck | null> {
  if (issue.status !== "on_hold" || !issue.linearIdentifier) return null;
  const identifier = issue.linearIdentifier;
  const out: LinearCheck = {
    issueId: issue.id,
    linearIdentifier: identifier,
    state: null,
    resolution: null,
  };
  let terminal = false;
  try {
    const triageChannel =
      issue.triageChannel ?? (await deskForIssue(db, issue)).triageChannel;
    const linear = await getLinearIssue(ctx, issue.linearIssueId ?? identifier);
    out.state = linear.status ?? linear.statusType ?? null;
    const r = resolution(linear);
    // The state is stored for the Console's board.
    if (!r) {
      await markLinearChecked(db, issue.id, out.state);
      return out;
    }
    terminal = true;
    const moved = await resolveIssue(ctx, db, triageChannel, {
      issueId: issue.id,
      identifier,
      url: linear.url,
      state: out.state ?? "",
      resolution: r,
      by,
    });
    // Stamped only once the resolution is applied, so a failed post or move leaves the check due.
    await markLinearChecked(db, issue.id, out.state);
    if (!moved) return out;
    out.resolution = r;
    await redrawCard(ctx, db, triageChannel, moved).catch((err) =>
      ctx.logger.warn("card redraw failed", {
        issueId: issue.id,
        err: String(err),
      }),
    );
  } catch (err) {
    // A failed read is stamped, so one broken Linear issue waits for the next backoff point. A
    // Done or Canceled that could not be applied is not: its check stays due, and the next tick
    // (an hour later at most) retries it; the per-post keys keep a retry from posting twice.
    if (!terminal) await markLinearChecked(db, issue.id).catch(() => undefined);
    ctx.logger.error("linear check failed for issue", {
      issueId: issue.id,
      linearIdentifier: identifier,
      err: String(err),
    });
    out.error = String(err);
  }
  return out;
}

/**
 * Someone clicked Resolved: move the On Hold issue to On You now, without reading Linear. Null
 * when the issue was not On Hold.
 */
export async function resolveByHand(
  ctx: Ctx,
  db: Db,
  triageChannel: string,
  issue: Issue,
  clicker: string,
): Promise<Issue | null> {
  if (issue.status !== "on_hold") return null;
  return resolveIssue(ctx, db, triageChannel, {
    issueId: issue.id,
    identifier: issue.linearIdentifier ?? "",
    url: issue.linearUrl ?? "",
    state: "Resolved in Slack",
    resolution: "resolved",
    by: clicker,
  });
}
