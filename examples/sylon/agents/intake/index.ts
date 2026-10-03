/**
 * intake: the Slack source adapter. A customer message becomes a classified issue (or a follow-up
 * on an open one), an issue card in the triage channel, and an `issue.created` or
 * `issue.message_added` event. Also owns the `issue.*` buttons (Take, Close) and the 🎫 reaction.
 *
 * Triggers: `slack.message.created`, `slack.reaction_added`, `slack.block_actions`. Triggers match
 * on type only, so `guard` filters and routes.
 */
import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

import {
  decodeAction,
  escapeMrkdwn,
  issueCard,
  issueCardText,
  mrkdwnLink,
  slackToPlain,
  replaceActions,
  workingCard,
} from "../../_shared/blocks";
import { customerChannel, getConfig, getConfigOr } from "../../_shared/config";
import { withDb, type Db, type DbCtx } from "../../_shared/db";
import { emit } from "../../_shared/emit";
import {
  SlackBlockActions,
  SlackMessageCreated,
  SlackReactionAdded,
  type SlackRef,
} from "../../_shared/events";
import {
  accountByChannel,
  assign,
  attachMessage,
  canTransition,
  compareSlackTs,
  decideDraft,
  ensureAccount,
  eventLogged,
  getAccount,
  getIssue,
  issueByCustomerThread,
  issueByTriageRoot,
  latestCustomerTs,
  linkMessage,
  lockIssue,
  messageBySlackTs,
  messageBySourceEventId,
  messagesForIssue,
  openIssueForMessage,
  openIssuesForAccount,
  pendingDrafts,
  recordRun,
  setStatus,
  setTriageRoot,
  type Account,
  type Issue,
} from "../../_shared/issues";
import {
  type SlackCtx,
  permalink,
  post,
  react,
  replies,
  restoreClicked,
  showWorking,
  unreact,
  update,
  userInfo,
} from "../../_shared/slack";
import {
  categoryOf,
  decide,
  priorityOf,
  questions,
  type Candidate,
  type Decision,
  type IntakeJev,
} from "./decide";
import { classifyPoster } from "./poster";

export const AGENT = "sylon-intake";
const TICKET = "ticket";
const EYES = "eyes";
/** `decided_by` on a draft that a teammate's own reply made moot. */
const SUPERSEDED_BY = "intake";
/** Open issues offered to Jev as link targets, newest first. */
const MAX_CANDIDATES = 10;

/** First 80 chars of the message as plain text (mentions and links made inert). */
/**
 * Drop a trailing client footer such as `*Sent using* <@U…>`, which some Slack clients (the Claude
 * Slack integration among them) append to the poster's text. It is not part of the message.
 */
export function stripClientFooter(text: string): string {
  // `lastIndexOf` plus an anchored check on that tail only: one regex over the whole message would
  // backtrack polynomially on long runs of spaces or repeated footers (CodeQL js/polynomial-redos).
  const trimmed = text.trimEnd();
  const at = trimmed.lastIndexOf(CLIENT_FOOTER);
  if (at < 0 || !FOOTER_TAIL.test(trimmed.slice(at))) return text;
  return trimmed.slice(0, at).trimEnd();
}

const CLIENT_FOOTER = "*Sent using*";
const FOOTER_TAIL = /^\*Sent using\*\s*<@[^<>]*>$/;

export const TITLE_MAX = 80;

/** The message as one plain line, at most `TITLE_MAX` characters, cut at a word with an ellipsis. */
export function titleOf(text: string): string {
  const line = slackToPlain(stripClientFooter(text))
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "(no text)";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  // Cut back to the last whole word, unless the cut already ends one; a single long word (a URL)
  // is cut mid-word rather than reduced to a stub.
  const space = line[cut.length] === " " ? cut.length : cut.lastIndexOf(" ");
  const head = space > TITLE_MAX / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s.,;:!?-]+$/, "")}…`;
}

const plain = (text: string) => escapeMrkdwn(slackToPlain(text));

// --- step payloads ---------------------------------------------------------------------------

/** A customer-channel message or 🎫 reaction, normalized. `eventId` is the causation id. */
const Incoming = z.object({
  eventId: z.string(),
  trigger: z.enum(["message", "reaction"]),
  channel: z.string(),
  ts: z.string(),
  threadTs: z.string().optional(),
  /** Unknown until `context` reads the message, for a reaction. */
  user: z.string().optional(),
  text: z.string().optional(),
});
type Incoming = z.infer<typeof Incoming>;

const Context = Incoming.extend({
  user: z.string(),
  text: z.string(),
  userName: z.string(),
  accountId: z.string(),
  /** For a reaction on a message already stored (e.g. a thank-you that opened no issue). */
  storedMessageId: z.string().nullable(),
  threadIssueId: z.string().nullable(),
  thread: z.array(z.object({ user: z.string(), text: z.string() })),
  candidates: z.array(
    z.object({
      issueId: z.string(),
      number: z.number(),
      title: z.string(),
      lastMessage: z.string().nullable(),
    }),
  ),
});
type Context = z.infer<typeof Context>;

const Classified = Context.extend({ jev: z.unknown().nullable() });
type Classified = z.infer<typeof Classified>;

const Persisted = z.object({
  incoming: Incoming,
  userName: z.string(),
  text: z.string(),
  accountId: z.string(),
  decision: z.enum(["open", "link", "ignore"]),
  reason: z.string().optional(),
  issueId: z.string().nullable(),
  messageId: z.string(),
  created: z.boolean(),
  /** This event was already stored by an earlier run: do not mirror it twice. */
  duplicate: z.boolean(),
});
type Persisted = z.infer<typeof Persisted>;

const Settle = z.object({
  incoming: Incoming,
  outcome: z.string(),
  issueId: z.string().nullable(),
  number: z.number().nullable(),
  opened: z.boolean(),
  receiptId: z.string().nullable(),
});
type Settle = z.infer<typeof Settle>;

const refOf = (i: Incoming): SlackRef =>
  i.threadTs && i.threadTs !== i.ts
    ? { channel: i.channel, ts: i.ts, threadTs: i.threadTs }
    : { channel: i.channel, ts: i.ts };

// --- guard -----------------------------------------------------------------------------------

const guard = defineStep({
  name: "guard",
  next: ["button", "internal", "team", "ack"],
  terminal: true,
  // The three trigger types arrive here; each branch parses its own schema.
  inputSchema: z.looseObject({}),
  async run(input, ctx) {
    if (input.type === "block_actions") {
      const click = SlackBlockActions.safeParse(input);
      if (!click.success)
        return terminate({ skipped: "malformed block_actions" });
      const decoded = decodeAction(click.data.actions[0].action_id);
      // E4's copilot owns `draft.*`; any other owner is not ours.
      if (decoded?.owner !== "issue")
        return terminate({
          skipped: `not an issue action: ${click.data.actions[0].action_id}`,
        });
      return goto("button", click.data);
    }

    const event = (input.event ?? {}) as { type?: unknown };
    if (event.type === "reaction_added") {
      const r = SlackReactionAdded.safeParse(input);
      if (!r.success) return terminate({ skipped: "malformed reaction" });
      const e = r.data.event;
      if (e.reaction !== TICKET)
        return terminate({ skipped: `reaction ${e.reaction}` });
      if (e.item.type !== "message")
        return terminate({ skipped: `reaction on ${e.item.type}` });
      const target = await withDb(ctx, async (db) =>
        (await knownChannel(db, e.item.channel))
          ? { stored: await messageBySlackTs(db, e.item.channel, e.item.ts) }
          : null,
      );
      if (!target)
        return terminate({
          skipped: `not a customer channel: ${e.item.channel}`,
        });
      // Includes intake's own 🎫 on a message it just opened an issue for: the connector delivers
      // the bot's reactions, so this exits before the 👀 ack.
      if (target.stored?.issueId)
        return terminate({
          skipped: "already an issue",
          issueId: target.stored.issueId,
        });
      return goto("ack", {
        eventId: r.data.eventId,
        trigger: "reaction",
        channel: e.item.channel,
        ts: e.item.ts,
      } satisfies Incoming);
    }

    if (event.type === "message") {
      const m = SlackMessageCreated.safeParse(input);
      if (!m.success) return terminate({ skipped: "malformed message" });
      const e = m.data.event;
      if (e.subtype || e.bot_id)
        return terminate({ skipped: "bot or edited message" });
      // The bot only receives events from channels it was invited to, so the invite is the control:
      // an outsider posting in any of them is a customer. The connector has no conversations.info, so
      // we cannot ask Slack whether a channel is shared; the poster's workspace decides instead.
      const route = await withDb(ctx, async (db) => {
        if ((await getConfig(db, "channels.triage")) === e.channel)
          return "triage";
        const poster = classifyPoster({
          user: e.user,
          userTeam: e.user_team,
          team: e.team,
          envelopeTeamId: m.data.teamId,
          teamSlackTeamIds: await getConfigOr(
            db,
            "team.slack_team_ids",
            undefined,
          ),
          testUserIds: await getConfigOr(db, "customers.test_user_ids", []),
        });
        if (poster === "customer") return "customer";
        // Our own engineers post in customer channels too, but in internal channels the bot is in
        // their chatter is not ours to keep: only a channel with an account gets the team step.
        return (await knownChannel(db, e.channel)) ? "team" : "ignore";
      });
      if (route === "triage") return goto("internal", m.data);
      if (route === "team") return goto("team", m.data);
      if (route === "ignore")
        return terminate({
          skipped: "team message outside a customer channel",
        });
      return goto("ack", {
        eventId: m.data.eventId,
        trigger: "message",
        channel: e.channel,
        ts: e.ts,
        threadTs: e.thread_ts,
        user: e.user,
        text: e.text,
      } satisfies Incoming);
    }

    return terminate({ skipped: "not a Slack event intake handles" });
  },
});

// --- triage-channel messages: stored as internal notes, nothing else in M1 ---------------------

const internal = defineStep({
  name: "internal",
  terminal: true,
  inputSchema: SlackMessageCreated,
  async run(input, ctx) {
    const e = input.event;
    return withDb(ctx, async (db) => {
      await recordRun(db, ctx, AGENT);
      const root = e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : null;
      const issue = root ? await issueByTriageRoot(db, root) : null;
      const { message, duplicate } = await linkMessage(db, {
        issueId: issue?.id,
        source: "slack",
        sourceEventId: input.eventId,
        direction: "internal",
        slack: root
          ? { channel: e.channel, ts: e.ts, threadTs: root }
          : { channel: e.channel, ts: e.ts },
        userId: e.user,
        text: e.text,
      });
      if (issue) await recordRun(db, ctx, AGENT, issue.id);
      return terminate({
        outcome: "internal",
        messageId: message.id,
        issueId: issue?.id ?? null,
        duplicate,
      });
    });
  },
});

// --- our team's messages in a customer channel -----------------------------------------------

/**
 * A teammate's message in a customer channel. It is never the customer waiting: no reaction, no
 * Jev call, no issue, no event (so copilot does not draft and the controller does not nudge). A
 * reply in an issue's thread is recorded as the team's answer and hands the ball to the customer.
 *
 * The superseded drafts' cards are not redrawn: that needs copilot's card builder and knowledge
 * base. The card's buttons still resolve, and `decideDraft` refuses a draft that is not pending.
 */
const team = defineStep({
  name: "team",
  terminal: true,
  inputSchema: SlackMessageCreated,
  async run(input, ctx) {
    const e = input.event;
    const root = e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : null;
    const slack = refOf({
      eventId: input.eventId,
      trigger: "message",
      channel: e.channel,
      ts: e.ts,
      threadTs: root ?? undefined,
    });
    return withDb(ctx, async (db) => {
      await recordRun(db, ctx, AGENT);
      const issueId = root ? await threadIssueFor(db, e.channel, root) : null;
      if (!issueId) {
        const { message, duplicate } = await linkMessage(db, {
          source: "slack",
          sourceEventId: input.eventId,
          direction: "agent",
          slack,
          userId: e.user,
          text: e.text,
        });
        return terminate({
          outcome: "team_message",
          messageId: message.id,
          issueId: null,
          duplicate,
        });
      }

      const poster = await userInfo(ctx, e.user);
      const { message, duplicate } = await linkMessage(db, {
        issueId,
        source: "slack",
        sourceEventId: input.eventId,
        direction: "agent",
        slack,
        userId: e.user,
        userName: poster.name,
        text: e.text,
      });
      // A redelivery, or a team message older than the customer's latest, must not undo what that
      // later message did: it would hand the ball back and supersede the follow-up's draft.
      const moved = await db.transaction(async (tx) => {
        const locked = await lockIssue(tx, issueId);
        if (duplicate) return { issue: locked, applied: false };
        const customerTs = await latestCustomerTs(tx, issueId);
        if (customerTs && compareSlackTs(e.ts, customerTs) < 0)
          return { issue: locked, applied: false };
        // Under the row lock, so a customer message landing now keeps its On You: the later write wins
        // only when it is legal. On Hold and Closed are not ours to move (no legal edge to on_customer).
        return {
          issue: canTransition(locked.status, "on_customer")
            ? await setStatus(tx, locked.id, "on_customer")
            : locked,
          applied: true,
        };
      });
      const issue = moved.issue;
      // Their reply answers what the drafts were for; an Approve now would answer twice.
      if (moved.applied)
        for (const draft of await pendingDrafts(db, issue.id))
          await decideDraft(db, draft.id, "superseded", SUPERSEDED_BY);
      await recordRun(db, ctx, AGENT, issue.id);

      const triageChannel = await getConfig(db, "channels.triage");
      if (issue.triageRootTs) {
        await refreshCard(
          ctx,
          triageChannel,
          issue,
          await getAccount(db, issue.accountId),
        );
        // A redelivery or retry finds the row already stored and mirrors nothing.
        if (!duplicate)
          await post(ctx, {
            channel: triageChannel,
            threadTs: issue.triageRootTs,
            text: `*${escapeMrkdwn(poster.name)}* (team): ${plain(stripClientFooter(e.text))} ${mrkdwnLink(
              permalink(e.channel, e.ts, root ?? undefined),
              "view",
            )}`,
          });
      }
      return terminate({
        outcome: "team_reply",
        messageId: message.id,
        issueId: issue.id,
        status: issue.status,
        duplicate,
      });
    });
  },
});

// --- customer message / 🎫 pipeline ----------------------------------------------------------

/** `intake.reactions`: off leaves no 👀 or 🎫 on customer messages (a shadow pilot). Default on. */
async function reactionsOn(ctx: DbCtx) {
  return withDb(
    ctx,
    async (db) => (await getConfigOr(db, "intake.reactions", true)) !== false,
  );
}

const ack = defineStep({
  name: "ack",
  next: ["context"],
  inputSchema: Incoming,
  async run(input, ctx) {
    if (await reactionsOn(ctx))
      await react(ctx, { channel: input.channel, ts: input.ts, name: EYES });
    return goto("context", input);
  },
});

/** A channel with an account (an outsider has posted there) or listed in `channels.customer`. */
async function knownChannel(db: Db, channel: string): Promise<boolean> {
  return !!(
    (await accountByChannel(db, channel)) ??
    (await customerChannel(db, channel))
  );
}

async function accountFor(db: Db, channel: string): Promise<Account> {
  const found = await accountByChannel(db, channel);
  if (found) return found;
  const customer = await customerChannel(db, channel);
  return ensureAccount(db, {
    name: customer?.accountName ?? channel,
    slackChannelId: channel,
  });
}

/**
 * The issue a reply in the thread rooted at `rootTs` belongs to: the issue that thread opened, else
 * the issue its root message was linked to (a new thread Jev linked to an existing issue).
 */
async function threadIssueFor(
  db: Db,
  channel: string,
  rootTs: string,
): Promise<string | null> {
  const opened = await issueByCustomerThread(db, channel, rootTs);
  if (opened) return opened.id;
  return (await messageBySlackTs(db, channel, rootTs))?.issueId ?? null;
}

async function candidatesFor(db: Db, accountId: string): Promise<Candidate[]> {
  const open = (await openIssuesForAccount(db, accountId)).slice(
    0,
    MAX_CANDIDATES,
  );
  return Promise.all(
    open.map(async (issue) => {
      const last = (await messagesForIssue(db, issue.id))
        .filter((m) => m.direction === "customer")
        .at(-1);
      return {
        issueId: issue.id,
        number: issue.number,
        title: issue.title ?? "(untitled)",
        lastMessage: last?.text ? titleOf(last.text) : null,
      };
    }),
  );
}

const context = defineStep({
  name: "context",
  next: ["classify", "settle"],
  inputSchema: Incoming,
  async run(input, ctx) {
    const rootTs = input.threadTs ?? input.ts;
    const found = await withDb(ctx, async (db) => {
      await recordRun(db, ctx, AGENT);
      const account = await accountFor(db, input.channel);
      const stored =
        input.trigger === "reaction"
          ? await messageBySlackTs(db, input.channel, input.ts)
          : null;
      // A top-level message's own row is not a thread root to link through (only a replay has one).
      const threadIssueId =
        rootTs === input.ts
          ? ((await issueByCustomerThread(db, input.channel, rootTs))?.id ??
            null)
          : await threadIssueFor(db, input.channel, rootTs);
      const candidates = await candidatesFor(db, account.id);
      return { account, stored, threadIssueId, candidates };
    });

    // A 🎫 on a message that already belongs to an issue: nothing to open.
    if (found.stored?.issueId) {
      return goto("settle", {
        incoming: input,
        outcome: "already an issue",
        issueId: found.stored.issueId,
        number: null,
        opened: false,
        receiptId: null,
      } satisfies Settle);
    }

    let { user, text } = input;
    let threadTs = input.threadTs;
    if (user === undefined || text === undefined) {
      if (found.stored) {
        user = found.stored.userId ?? "unknown";
        text = found.stored.text ?? "";
        threadTs = found.stored.threadTs ?? undefined;
      } else {
        // conversations.replies with a message's own ts returns that message (and its thread).
        const row = (
          await replies(ctx, { channel: input.channel, ts: input.ts })
        ).find((r) => r.ts === input.ts);
        if (!row?.user) {
          return goto("settle", {
            incoming: input,
            outcome: "reacted message not found",
            issueId: null,
            number: null,
            opened: false,
            receiptId: null,
          } satisfies Settle);
        }
        user = row.user;
        text = row.text ?? "";
        threadTs =
          row.thread_ts && row.thread_ts !== row.ts ? row.thread_ts : undefined;
      }
    }

    const thread =
      threadTs && threadTs !== input.ts
        ? (await replies(ctx, { channel: input.channel, ts: threadTs }))
            .filter((r) => r.ts !== input.ts)
            .slice(-20)
            .map((r) => ({
              user: r.user ?? r.bot_id ?? "unknown",
              text: slackToPlain(r.text ?? ""),
            }))
        : [];
    const poster = await userInfo(ctx, user);
    // The thread lookup above used the input's root; a reaction learns its root only now.
    let threadIssueId = found.threadIssueId;
    if (!threadIssueId && threadTs && threadTs !== rootTs) {
      threadIssueId = await withDb(ctx, (d) =>
        threadIssueFor(d, input.channel, threadTs!),
      );
    }

    return goto("classify", {
      ...input,
      threadTs,
      user,
      text,
      userName: poster.name,
      accountId: found.account.id,
      storedMessageId: found.stored?.id ?? null,
      threadIssueId,
      thread,
      candidates: found.candidates,
    } satisfies Context);
  },
});

const classify = defineStep({
  name: "classify",
  next: ["persist"],
  inputSchema: Context,
  async run(input, ctx) {
    // A reply in an issue's customer thread links regardless of what Jev says; skip the call.
    if (input.threadIssueId)
      return goto("persist", { ...input, jev: null } satisfies Classified);
    const account = await withDb(ctx, (db) => getAccount(db, input.accountId));
    let jev: IntakeJev | null = null;
    try {
      const res = await ctx.sapiom.decisions.evaluate({
        state: {
          message: slackToPlain(input.text),
          from: input.userName,
          thread: input.thread,
          account: account.name,
          openIssues: input.candidates.map((c) => ({
            number: c.number,
            title: c.title,
            lastMessage: c.lastMessage,
          })),
        },
        questions: questions(input.candidates),
      });
      jev = res.answers as unknown as IntakeJev;
    } catch (err) {
      // `decide` opens an unclassified issue rather than drop the message.
      ctx.logger.warn("decisions.evaluate failed; continuing unclassified", {
        err: String(err),
      });
    }
    return goto("persist", { ...input, jev } satisfies Classified);
  },
});

const persist = defineStep({
  name: "persist",
  next: ["announce", "settle"],
  inputSchema: Classified,
  async run(input, ctx) {
    const jev = (input.jev ?? null) as IntakeJev | null;
    const decision: Decision = decide({
      threadIssueId: input.threadIssueId,
      forced: input.trigger === "reaction",
      jev,
      candidates: input.candidates,
    });
    const incoming: Incoming = {
      eventId: input.eventId,
      trigger: input.trigger,
      channel: input.channel,
      ts: input.ts,
      threadTs: input.threadTs,
      user: input.user,
      text: input.text,
    };
    const slack = refOf(incoming);

    return withDb(ctx, async (db) => {
      // The message row first: keyed on the Slack event id, it makes a retry or a redelivery a no-op.
      let messageId = input.storedMessageId;
      let duplicate = false;
      const replay = messageId
        ? null
        : await messageBySourceEventId(db, input.eventId);
      if (replay?.issueId) {
        // A redelivered event, or a retry after the first attempt stored the message: replay the
        // same outcome. The emit id dedups, and `duplicate` keeps the mirror from posting twice.
        const issue = await getIssue(db, replay.issueId);
        const first = (await messagesForIssue(db, issue.id))[0];
        // The fresh path moves the status before it emits, so a logged `issue.message_added` means
        // the move happened; replaying it then would reopen an issue a teammate has since closed.
        // No logged emit means the first attempt died in between and the move is still owed.
        if (
          first?.id !== replay.id &&
          !(await eventLogged(db, "issue.message_added", input.eventId))
        )
          await followUp(db, issue.id);
        return goto("announce", {
          incoming,
          userName: input.userName,
          text: input.text,
          accountId: input.accountId,
          messageId: replay.id,
          duplicate: true,
          decision: first?.id === replay.id ? "open" : "link",
          reason: "replay",
          issueId: issue.id,
          created: false,
        } satisfies Persisted);
      }
      if (!messageId) {
        const linked = await linkMessage(db, {
          issueId: decision.kind === "link" ? decision.issueId : undefined,
          source: "slack",
          sourceEventId: input.eventId,
          direction: "customer",
          slack,
          userId: input.user,
          userName: input.userName,
          text: input.text,
          jev,
        });
        messageId = linked.message.id;
        duplicate = linked.duplicate;
        if (decision.kind === "link" && !linked.message.issueId)
          await attachMessage(db, messageId, decision.issueId);
      }

      const base = {
        incoming,
        userName: input.userName,
        text: input.text,
        accountId: input.accountId,
        messageId,
        duplicate,
      };

      if (decision.kind === "ignore") {
        return goto("settle", {
          incoming,
          outcome: "not an issue",
          issueId: null,
          number: null,
          opened: false,
          receiptId: null,
        } satisfies Settle);
      }

      if (decision.kind === "open") {
        // Locks the message row, so overlapping runs for this message agree on one issue.
        const { issue, created } = await openIssueForMessage(db, messageId, {
          accountId: input.accountId,
          source: "slack",
          category: categoryOf(jev),
          priority: priorityOf(jev),
          title: titleOf(input.text),
          customer: slack,
        });
        await recordRun(db, ctx, AGENT, issue.id);
        return goto("announce", {
          ...base,
          decision: "open",
          reason: decision.reason,
          issueId: issue.id,
          created,
        } satisfies Persisted);
      }

      const current = await followUp(db, decision.issueId);
      await recordRun(db, ctx, AGENT, current.id);
      return goto("announce", {
        ...base,
        decision: "link",
        reason: decision.reason,
        issueId: current.id,
        created: false,
      } satisfies Persisted);
    });
  },
});

/** A follow-up puts the ball back with the team; On Hold stays On Hold until engineering is done. */
async function followUp(db: Db, issueId: string): Promise<Issue> {
  const current = await getIssue(db, issueId);
  return current.status === "on_hold"
    ? current
    : setStatus(db, current.id, "on_you");
}

async function refreshCard(
  ctx: SlackCtx,
  triageChannel: string,
  issue: Issue,
  account: Account,
) {
  if (!issue.triageRootTs) return;
  await update(ctx, {
    channel: triageChannel,
    ts: issue.triageRootTs,
    text: issueCardText(issue, account),
    blocks: issueCard(issue, account),
  });
}

const announce = defineStep({
  name: "announce",
  next: ["notify"],
  inputSchema: Persisted,
  async run(input, ctx) {
    return withDb(ctx, async (db) => {
      const triageChannel = await getConfig(db, "channels.triage");
      const account = await getAccount(
        db,
        (await getIssue(db, input.issueId!)).accountId,
      );
      const mirror = `*${escapeMrkdwn(input.userName)}*: ${plain(stripClientFooter(input.text))} ${mrkdwnLink(
        permalink(
          input.incoming.channel,
          input.incoming.ts,
          input.incoming.threadTs,
        ),
        "view",
      )}`;
      // Overlapping runs for one issue (a retry beside a slow first attempt, or two messages at once)
      // both see no card on an unlocked read; under the row lock only the first posts one.
      const { issue, carded } = await db.transaction(async (tx) => {
        const locked = await lockIssue(tx, input.issueId!);
        if (locked.triageRootTs) return { issue: locked, carded: false };
        const card = await post(ctx, {
          channel: triageChannel,
          text: issueCardText(locked, account),
          blocks: issueCard(locked, account),
        });
        return {
          issue: await setTriageRoot(tx, locked.id, card.ts),
          carded: true,
        };
      });
      if (carded) {
        // First sighting (or a retry after a failed card post): the message goes under the new card.
        await post(ctx, {
          channel: triageChannel,
          threadTs: issue.triageRootTs!,
          text: mirror,
        });
      } else if (input.decision === "link") {
        // The card shows the status the follow-up set; a replay refreshes it but mirrors nothing.
        await refreshCard(ctx, triageChannel, issue, account);
        if (!input.duplicate)
          await post(ctx, {
            channel: triageChannel,
            threadTs: issue.triageRootTs!,
            text: mirror,
          });
      }
      return goto("notify", input);
    });
  },
});

const notify = defineStep({
  name: "notify",
  next: ["settle"],
  inputSchema: Persisted,
  async run(input, ctx) {
    return withDb(ctx, async (db) => {
      const issue = await getIssue(db, input.issueId!);
      const envelope = {
        issueId: issue.id,
        accountId: issue.accountId,
        source: "slack" as const,
        causationId: input.incoming.eventId,
        slack: refOf(input.incoming),
      };
      // The emit id is `<type>:<causationId>`, so a redelivered event's emit dedups.
      const receipt =
        input.decision === "open"
          ? await emit(ctx, db, "issue.created", {
              ...envelope,
              category: issue.category ?? "other",
              priority: issue.priority ?? "normal",
              title: issue.title ?? "",
            })
          : await emit(ctx, db, "issue.message_added", {
              ...envelope,
              messageId: input.messageId,
              text: slackToPlain(input.text),
            });
      return goto("settle", {
        incoming: input.incoming,
        outcome: input.decision === "open" ? "opened" : "linked",
        issueId: issue.id,
        number: issue.number,
        opened: input.decision === "open",
        receiptId: receipt.receiptId,
      } satisfies Settle);
    });
  },
});

const settle = defineStep({
  name: "settle",
  terminal: true,
  inputSchema: Settle,
  async run(input, ctx) {
    const at = { channel: input.incoming.channel, ts: input.incoming.ts };
    if (await reactionsOn(ctx)) {
      await unreact(ctx, { ...at, name: EYES });
      if (input.opened) await react(ctx, { ...at, name: TICKET });
    }
    return terminate({
      outcome: input.outcome,
      trigger: input.incoming.trigger,
      issueId: input.issueId,
      number: input.number,
      receiptId: input.receiptId,
    });
  },
});

// --- issue.* buttons -------------------------------------------------------------------------

const IssueId = z.string().uuid();

/**
 * A click on a nudge: the issue card was refreshed, so the nudge's own buttons give way to the
 * outcome. Best effort; the decision is already made.
 */
async function settleClicked(
  ctx: SlackCtx,
  click: SlackBlockActions,
  line: string,
): Promise<void> {
  const channel = click.container?.channel_id;
  const ts = click.container?.message_ts;
  const blocks = replaceActions(
    click.message?.blocks,
    click.actions[0]?.block_id,
    line,
  );
  if (!channel || !ts || !blocks) return;
  try {
    await update(ctx, { channel, ts, text: click.message?.text, blocks });
  } catch (err) {
    ctx.logger.warn("clicked nudge not redrawn", { err: String(err) });
  }
}

const button = defineStep({
  name: "button",
  terminal: true,
  inputSchema: SlackBlockActions,
  async run(input, ctx) {
    const action = input.actions[0];
    const verb = decodeAction(action.action_id)?.verb;
    const issueId = IssueId.safeParse(action.value);
    if (!issueId.success)
      return terminate({ skipped: `no issue id in ${action.action_id}` });
    const clicker = input.user.id;
    // Before any database work, so the click shows at once; every path below redraws the card.
    if (verb === "take" || verb === "close")
      await showWorking(ctx, input, verb, workingCard);

    return withDb(ctx, async (db) => {
      // Issue cards and nudges live only in the triage channel. A click from anywhere else (say a
      // customer replaying a payload with a guessed issue id) is ignored before any write.
      const triageChannel = await getConfig(db, "channels.triage");
      const from = input.container?.channel_id;
      if (from !== triageChannel) {
        ctx.logger.warn("issue action outside the triage channel; ignored", {
          actionId: action.action_id,
          channel: from ?? null,
          user: clicker,
        });
        await restoreClicked(ctx, input);
        return terminate({
          skipped: `issue action from channel ${from ?? "unknown"}, not triage`,
        });
      }
      await recordRun(db, ctx, AGENT);
      const rows = await db.query("select 1 from issues where id = $1", [
        issueId.data,
      ]);
      if (rows.length === 0) {
        await restoreClicked(ctx, input);
        return terminate({ skipped: `issue ${issueId.data} not found` });
      }
      await recordRun(db, ctx, AGENT, issueId.data);
      if (verb !== "take" && verb !== "close")
        return terminate({
          skipped: `unknown issue action ${action.action_id}`,
        });

      // Decided under the row lock, so of two overlapping Close clicks only the one that moved the
      // issue posts "Closed by". Take on an unowned issue is last-click-wins by design.
      const { issue, changed } = await db.transaction(async (tx) => {
        const locked = await lockIssue(tx, issueId.data);
        if (verb === "take") {
          // An owned or closed issue keeps its owner.
          if (locked.ownerSlackId || locked.status === "closed")
            return { issue: locked, changed: false };
          return { issue: await assign(tx, locked.id, clicker), changed: true };
        }
        if (locked.status === "closed")
          return { issue: locked, changed: false };
        return {
          issue: await setStatus(tx, locked.id, "closed"),
          changed: true,
        };
      });

      // The click may come from a controller nudge, so the card is always addressed by triage_root_ts.
      const account = await getAccount(db, issue.accountId);
      await refreshCard(ctx, triageChannel, issue, account);
      if (input.container?.message_ts !== issue.triageRootTs) {
        const line =
          verb === "take"
            ? changed
              ? `Taken by <@${clicker}>`
              : issue.status === "closed"
                ? "Issue is closed"
                : `Owned by <@${issue.ownerSlackId}>`
            : changed
              ? `Closed by <@${clicker}>`
              : "Already closed";
        await settleClicked(ctx, input, line);
      }
      if (verb === "close" && changed && issue.triageRootTs) {
        await post(ctx, {
          channel: triageChannel,
          threadTs: issue.triageRootTs,
          text: `Closed by <@${clicker}>`,
        });
      }
      return terminate({
        outcome: verb,
        changed,
        issueId: issue.id,
        status: issue.status,
        owner: issue.ownerSlackId,
      });
    });
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Sylon intake: a customer Slack message becomes a classified issue or a follow-up, an issue card in triage, and an issue.* event. Handles Take, Close and the ticket reaction.",
  entry: "guard",
  steps: {
    guard,
    internal,
    team,
    ack,
    context,
    classify,
    persist,
    announce,
    notify,
    settle,
    button,
  },
});
