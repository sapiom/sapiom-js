/**
 * intake: the Slack source adapter. A customer message becomes a classified issue (or a follow-up
 * on an open one), an issue card in the triage channel, and an `issue.created` or
 * `issue.message_added` event. Also owns the `issue.*` buttons (Take, Close, Resolved) and the 🎫
 * reaction. After each change to an issue it resets the issue's controller timer
 * (`_shared/timers.ts`); a customer message on an On Hold issue also reads its Linear issue.
 *
 * Triggers: `slack.message.created`, `slack.reaction_added`, `slack.block_actions`. Triggers match
 * on type only, so `guard` filters and routes.
 */
import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

import { agentSlug } from "../../_shared/fleet-id";
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
import { customerChannel, getConfigOr } from "../../_shared/config";
import {
  cardChannel,
  defaultDesk,
  deskBySlug,
  deskByTriageChannel,
  deskForIssue,
} from "../../_shared/desks";
import { withDb, type Db, type DbCtx } from "../../_shared/db";
import { emit } from "../../_shared/emit";
import { issueSla } from "../../_shared/sla";
import {
  PERSON_SUBTYPES,
  SlackBlockActions,
  SlackMessageCreated,
  SlackReactionAdded,
  messageText,
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
import { commentIssue, getIssue as getLinearIssue } from "../../_shared/linear";
import {
  checkLinear,
  redrawCard,
  resolution,
  resolveByHand,
} from "../../_shared/linear-check";
import { rescheduleIssue } from "../../_shared/timers";
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

export const AGENT = agentSlug("intake");
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
  /** The installing workspace, from the event envelope: who counts as the team when unconfigured. */
  teamId: z.string().optional(),
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
  next: ["button", "internal", "team", "ack", "react"],
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
      if (e.item.type !== "message")
        return terminate({ skipped: `reaction on ${e.item.type}` });
      // Any other emoji may be a teammate acknowledging the customer, or ✅ closing the issue.
      if (e.reaction !== TICKET) return goto("react", r.data);
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
        teamId: r.data.teamId,
        trigger: "reaction",
        channel: e.item.channel,
        ts: e.item.ts,
      } satisfies Incoming);
    }

    if (event.type === "message") {
      const m = SlackMessageCreated.safeParse(input);
      if (!m.success) return terminate({ skipped: "malformed message" });
      const e = m.data.event;
      // A reply with a screenshot arrives as `file_share`: dropping it lost the team's answer.
      if ((e.subtype && !PERSON_SUBTYPES.has(e.subtype)) || e.bot_id)
        return terminate({ skipped: "bot or edited message" });
      // The bot only receives events from channels it was invited to, so the invite is the control:
      // an outsider posting in any of them is a customer. The connector has no conversations.info, so
      // we cannot ask Slack whether a channel is shared; the poster's workspace decides instead.
      const route = await withDb(ctx, async (db) => {
        if (await deskByTriageChannel(db, e.channel)) return "triage";
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
        if (poster === "customer")
          return (await listedOnly(db)) &&
            !(await customerChannel(db, e.channel))
            ? "unlisted"
            : "customer";
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
      if (route === "unlisted")
        return terminate({
          skipped: `channel ${e.channel} is not in channels.customer`,
        });
      return goto("ack", {
        eventId: m.data.eventId,
        teamId: m.data.teamId,
        trigger: "message",
        channel: e.channel,
        ts: e.ts,
        threadTs: e.thread_ts,
        user: e.user,
        text: messageText(e),
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
      // A thread in one desk's triage channel never attaches to another desk's issue.
      const desk = await deskByTriageChannel(db, e.channel);
      const found = root ? await issueByTriageRoot(db, root) : null;
      const issue = found && found.deskId === desk?.id ? found : null;
      const { message, duplicate } = await linkMessage(db, {
        issueId: issue?.id,
        source: "slack",
        sourceEventId: input.eventId,
        direction: "internal",
        slack: root
          ? { channel: e.channel, ts: e.ts, threadTs: root }
          : { channel: e.channel, ts: e.ts },
        userId: e.user,
        text: messageText(e),
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

/** How soon after the customer's latest message a teammate's top-level post still answers it. */
export const TOP_LEVEL_ANSWER_SECONDS = 60 * 60;

/**
 * The issue a teammate's top-level message in a customer channel answers, when that is unambiguous:
 * exactly one issue in the channel is waiting on the team (New or On You) and its latest customer
 * message came less than an hour before. Teams often answer in the channel instead of the thread;
 * with two waiting issues, or an old one, the message could be about anything, so it answers none.
 */
async function topLevelAnswerTarget(
  db: Db,
  channel: string,
  ts: string,
): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    "select id from issues where customer_channel = $1 and status in ('new', 'on_you')",
    [channel],
  );
  const recent: string[] = [];
  for (const { id } of rows) {
    const customerTs = await latestCustomerTs(db, String(id));
    if (!customerTs || compareSlackTs(ts, customerTs) < 0) continue;
    if (Number(ts) - Number(customerTs) <= TOP_LEVEL_ANSWER_SECONDS)
      recent.push(String(id));
  }
  return rows.length === 1 && recent.length === 1 ? recent[0] : null;
}

/**
 * A teammate answered issue `issueId`: a reply in its customer thread, a reaction on the customer's
 * latest message, or Handled on the card. Stored as the team's message, it hands the ball to the
 * customer, makes the teammate the owner of an unowned issue, retires the pending drafts and
 * redraws the card. The caller reschedules the issue's timer.
 *
 * The message is stored in the same transaction as the move, so a run that fails before the commit
 * leaves no stored row behind and its retry applies the move instead of skipping it as a duplicate.
 * A redelivery, or an answer older than the customer's latest message, must not undo what that later
 * message did: it would hand the ball back and supersede the follow-up's draft.
 */
async function recordTeamAnswer(
  ctx: SlackCtx,
  db: Db,
  a: {
    issueId: string;
    eventId: string;
    user: string;
    userName: string;
    slack: SlackRef;
    text: string;
  },
) {
  const { message, duplicate, ...moved } = await db.transaction(async (tx) => {
    const locked = await lockIssue(tx, a.issueId);
    const { message, duplicate } = await linkMessage(tx, {
      issueId: a.issueId,
      source: "slack",
      sourceEventId: a.eventId,
      direction: "agent",
      slack: a.slack,
      userId: a.user,
      userName: a.userName,
      text: a.text,
    });
    const skip = { message, duplicate, issue: locked, applied: false };
    if (duplicate) return skip;
    const customerTs = await latestCustomerTs(tx, a.issueId);
    if (customerTs && compareSlackTs(a.slack.ts, customerTs) < 0) return skip;
    // Under the row lock, so a customer message landing now keeps its On You: the later write wins
    // only when it is legal. On Hold and Closed are not ours to move (no legal edge to on_customer).
    let issue = canTransition(locked.status, "on_customer")
      ? await setStatus(tx, locked.id, "on_customer")
      : locked;
    // Whoever answers an unowned issue owns it, as if they had clicked Take; no_owner stops.
    if (!issue.ownerSlackId && issue.status !== "closed")
      issue = await assign(tx, issue.id, a.user);
    return { message, duplicate, issue, applied: true };
  });
  const issue = moved.issue;
  // The answer covers what the drafts were for; an Approve now would answer twice.
  if (moved.applied)
    for (const draft of await pendingDrafts(db, issue.id))
      await decideDraft(db, draft.id, "superseded", SUPERSEDED_BY);
  await recordRun(db, ctx as DbCtx, AGENT, issue.id);
  // Nothing is copied into the triage thread: the card's status shows the team answered.
  if (issue.triageRootTs)
    await refreshCard(
      ctx,
      db,
      await cardChannel(db, issue),
      issue,
      await getAccount(db, issue.accountId),
    );
  return { message, duplicate, issue, applied: moved.applied };
}

/**
 * A teammate's message in a customer channel. It is never the customer waiting: no reaction, no
 * Jev call, no issue, no event (so copilot does not draft and the controller does not nudge). A
 * reply in an issue's thread is recorded as the team's answer, hands the ball to the customer, and
 * makes the poster the owner of an unowned issue.
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
      const issueId = root
        ? await threadIssueFor(db, e.channel, root)
        : await topLevelAnswerTarget(db, e.channel, e.ts);
      if (!issueId) {
        const { message, duplicate } = await linkMessage(db, {
          source: "slack",
          sourceEventId: input.eventId,
          direction: "agent",
          slack,
          userId: e.user,
          text: messageText(e),
        });
        return terminate({
          outcome: "team_message",
          messageId: message.id,
          issueId: null,
          duplicate,
        });
      }

      const poster = await userInfo(ctx, e.user);
      const { message, duplicate, issue } = await recordTeamAnswer(ctx, db, {
        issueId,
        eventId: input.eventId,
        user: e.user,
        userName: poster.name,
        slack,
        text: messageText(e),
      });
      // The team answered: the customer_waiting and draft_pending clocks stop.
      await rescheduleIssue(db, ctx, issue.id);
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

// --- a teammate's reaction ----------------------------------------------------------------

/** A teammate's ✅ on a customer message or on the issue card closes the issue. */
const CLOSE_REACTIONS = new Set(["white_check_mark", "heavy_check_mark"]);

/**
 * A reaction other than 🎫. From a teammate, on the customer's latest message in an issue, it is the
 * team's answer (as a reply would be), so the issue stops waiting on us; ✅ there or on the card
 * closes the issue. Reactions by the customer, on older messages or on anything else change nothing.
 */
const reaction = defineStep({
  name: "react",
  terminal: true,
  inputSchema: SlackReactionAdded,
  async run(input, ctx) {
    const e = input.event;
    const close = CLOSE_REACTIONS.has(e.reaction);
    return withDb(ctx, async (db) => {
      const stored = await messageBySlackTs(db, e.item.channel, e.item.ts);
      const card = stored
        ? null
        : await issueByTriageRoot(db, e.item.ts).then((i) =>
            i && i.triageChannel === e.item.channel ? i : null,
          );
      const issueId = stored?.issueId ?? card?.id;
      if (!issueId) return terminate({ skipped: "not an issue message" });
      if (card && !close)
        return terminate({ skipped: `reaction ${e.reaction} on the card` });
      if (stored && stored.direction !== "customer")
        return terminate({ skipped: "not a customer message" });

      const person = await userInfo(ctx, e.user);
      const poster = classifyPoster({
        user: e.user,
        userTeam: person.teamId,
        envelopeTeamId: input.teamId,
        teamSlackTeamIds: await getConfigOr(
          db,
          "team.slack_team_ids",
          undefined,
        ),
        testUserIds: await getConfigOr(db, "customers.test_user_ids", []),
      });
      if (poster === "customer")
        return terminate({ skipped: "the customer's reaction", issueId });
      await recordRun(db, ctx, AGENT, issueId);

      if (close) {
        const { issue, changed } = await db.transaction(async (tx) => {
          const locked = await lockIssue(tx, issueId);
          if (locked.status === "closed")
            return { issue: locked, changed: false };
          return {
            issue: await setStatus(tx, locked.id, "closed"),
            changed: true,
          };
        });
        if (changed && issue.triageRootTs) {
          const triageChannel = await cardChannel(db, issue);
          try {
            await refreshCard(
              ctx,
              db,
              triageChannel,
              issue,
              await getAccount(db, issue.accountId),
            );
            await post(ctx, {
              channel: triageChannel,
              threadTs: issue.triageRootTs,
              text: `Closed by <@${e.user}> with :${e.reaction}:`,
            });
          } finally {
            await noteOpenLinear(ctx, triageChannel, issue);
          }
          await rescheduleIssue(db, ctx, issue.id);
        }
        return terminate({ outcome: "close", changed, issueId });
      }

      // Only the latest customer message: a reaction on an older one says nothing about the newest.
      if (stored!.ts !== (await latestCustomerTs(db, issueId)))
        return terminate({
          skipped: "not the latest customer message",
          issueId,
        });
      const issue = await getIssue(db, issueId);
      const eventTs =
        e.event_ts ??
        `${input.eventTime ?? Math.floor(Date.now() / 1000)}.000000`;
      const { duplicate } = await recordTeamAnswer(ctx, db, {
        issueId,
        eventId: input.eventId,
        user: e.user,
        userName: person.name,
        slack: {
          channel: e.item.channel,
          ts: eventTs,
          threadTs: issue.customerRootTs ?? e.item.ts,
        },
        text: `(reacted :${e.reaction}:)`,
      });
      await rescheduleIssue(db, ctx, issueId);
      return terminate({ outcome: "acknowledged", issueId, duplicate });
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

/** `intake.listed_channels_only`: only `channels.customer` entries are customer channels. */
const listedOnly = (db: Db) =>
  getConfigOr(db, "intake.listed_channels_only", false);

/**
 * A channel listed in `channels.customer`, or one with an account (an outsider has posted there)
 * unless `intake.listed_channels_only` is on.
 */
async function knownChannel(db: Db, channel: string): Promise<boolean> {
  if (await customerChannel(db, channel)) return true;
  return !(await listedOnly(db)) && !!(await accountByChannel(db, channel));
}

/**
 * The channel's account, created on first sight under the desk its `channels.customer` entry
 * names, else the default desk. Null when no desk applies (an unknown slug, or no default desk):
 * the message is skipped, never filed on a desk nobody chose.
 */
async function accountFor(db: Db, channel: string): Promise<Account | null> {
  const found = await accountByChannel(db, channel);
  if (found) return found;
  const customer = await customerChannel(db, channel);
  const desk = customer?.desk
    ? await deskBySlug(db, customer.desk)
    : await defaultDesk(db);
  if (!desk) return null;
  return ensureAccount(db, {
    name: customer?.accountName ?? channel,
    slackChannelId: channel,
    deskId: desk.id,
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
      if (!account) return null;
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

    if (!found) {
      ctx.logger.warn("no desk for customer channel; skipped", {
        channel: input.channel,
      });
      return goto("settle", {
        incoming: input,
        outcome: "no desk for channel",
        issueId: null,
        number: null,
        opened: false,
        receiptId: null,
      } satisfies Settle);
    }

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
        await assignMentioned(ctx, db, issue.id, input.text, input.teamId);
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
      await assignMentioned(ctx, db, current.id, input.text, input.teamId);
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

/** `<@U123>` or `<@U123|name>` in Slack message text. */
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * The customer addressed a teammate by name (`@Ilan where are we on...`): on an issue with no owner,
 * that teammate becomes the owner, so the card and any nudge go to them rather than to the whole
 * triage channel. The first mention that is a person on our team wins; bots and customers are skipped.
 */
async function assignMentioned(
  ctx: SlackCtx,
  db: Db,
  issueId: string,
  text: string,
  envelopeTeamId: string | undefined,
): Promise<void> {
  const ids = [...new Set([...text.matchAll(MENTION)].map((m) => m[1]))];
  if (ids.length === 0) return;
  const issue = await getIssue(db, issueId);
  if (issue.ownerSlackId || issue.status === "closed") return;
  const teamSlackTeamIds = await getConfigOr(
    db,
    "team.slack_team_ids",
    undefined,
  );
  const testUserIds = await getConfigOr(db, "customers.test_user_ids", []);
  for (const id of ids) {
    const person = await userInfo(ctx, id).catch(() => null);
    if (!person || person.isBot) continue;
    const side = classifyPoster({
      user: id,
      userTeam: person.teamId,
      envelopeTeamId: envelopeTeamId ?? "",
      teamSlackTeamIds,
      testUserIds,
    });
    if (side !== "team") continue;
    // Under the row lock: a Take landing at the same moment keeps its owner.
    await db.transaction(async (tx) => {
      const locked = await lockIssue(tx, issueId);
      if (!locked.ownerSlackId && locked.status !== "closed")
        await assign(tx, issueId, id);
    });
    return;
  }
}

/** A follow-up puts the ball back with the team; On Hold stays On Hold until engineering is done. */
async function followUp(db: Db, issueId: string): Promise<Issue> {
  const current = await getIssue(db, issueId);
  return current.status === "on_hold"
    ? current
    : setStatus(db, current.id, "on_you");
}

async function refreshCard(
  ctx: SlackCtx,
  db: Db,
  triageChannel: string,
  issue: Issue,
  account: Account,
) {
  if (!issue.triageRootTs) return;
  await update(ctx, {
    channel: triageChannel,
    ts: issue.triageRootTs,
    text: issueCardText(issue, account),
    blocks: issueCard(issue, account, await issueSla(db, issue)),
  });
}

const announce = defineStep({
  name: "announce",
  next: ["notify"],
  inputSchema: Persisted,
  async run(input, ctx) {
    return withDb(ctx, async (db) => {
      const current = await getIssue(db, input.issueId!);
      const triageChannel = (await deskForIssue(db, current)).triageChannel;
      const account = await getAccount(db, current.accountId);
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
          blocks: issueCard(locked, account, await issueSla(tx, locked)),
        });
        return {
          issue: await setTriageRoot(tx, locked.id, triageChannel, card.ts),
          carded: true,
        };
      });
      // An existing card stays where it was posted, even after its desk's channel moved.
      const cardIn = issue.triageChannel ?? triageChannel;
      if (carded) {
        // First sighting (or a retry after a failed card post): the message goes under the new card.
        await post(ctx, {
          channel: cardIn,
          threadTs: issue.triageRootTs!,
          text: mirror,
        });
      } else if (input.decision === "link") {
        // A follow-up only redraws the card with the status it set. Copying each message into the
        // triage thread duplicated the whole conversation and notified everyone following it; the
        // card links to the customer thread instead.
        await refreshCard(ctx, db, cardIn, issue, account);
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
      let issue = await getIssue(db, input.issueId!);
      // The customer wrote on an escalated issue: Linear may already be done with it, so read it
      // now rather than at the On Hold check's next backoff point.
      if (input.decision === "link" && issue.status === "on_hold") {
        await checkLinear(ctx, db, issue, AGENT);
        issue = await getIssue(db, issue.id);
      }
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
      await rescheduleIssue(db, ctx, issue.id);
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

/**
 * A closed issue's Linear issue is never read again, so an unresolved Linear ticket is flagged here.
 * Never throws: the close is already committed and a retried step would see it as already closed.
 */
export async function noteOpenLinear(
  ctx: SlackCtx,
  triageChannel: string,
  issue: Issue,
): Promise<void> {
  const identifier = issue.linearIdentifier;
  if (!identifier) return;
  let linear;
  try {
    linear = await getLinearIssue(ctx, issue.linearIssueId ?? identifier);
  } catch (err) {
    ctx.logger.warn("linear state not read on close", {
      issueId: issue.id,
      linear: identifier,
      err: String(err),
    });
    return;
  }
  if (resolution(linear)) return;
  const url = issue.linearUrl ?? linear.url;
  const name = escapeMrkdwn(identifier);
  if (issue.triageRootTs) {
    try {
      await post(ctx, {
        channel: triageChannel,
        threadTs: issue.triageRootTs,
        text: `${url ? mrkdwnLink(url, name) : name} is still open in Linear. Cancel it there if it no longer needs work.`,
      });
    } catch (err) {
      ctx.logger.warn("open Linear note not posted", {
        issueId: issue.id,
        err: String(err),
      });
    }
  }
  try {
    await commentIssue(
      ctx,
      linear.id,
      `Support desk ticket ${issue.number} was closed in Slack while this ticket was still open. Cancel this ticket if it no longer needs work.`,
    );
  } catch (err) {
    ctx.logger.warn("open Linear comment not added", {
      issueId: issue.id,
      linear: identifier,
      err: String(err),
    });
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
    const known =
      verb === "take" ||
      verb === "close" ||
      verb === "resolve" ||
      verb === "handled";
    // Before any database work, so the click shows at once; every path below redraws the card.
    if (known) await showWorking(ctx, input, verb, workingCard);

    return withDb(ctx, async (db) => {
      // Restrict issue decisions to desk or stored card channels so forged customer clicks cannot
      // change an issue.
      const from = input.container?.channel_id;
      const rows = await db.query<{
        desk_id: string | null;
        triage_channel: string | null;
      }>("select desk_id, triage_channel from issues where id = $1", [
        issueId.data,
      ]);
      const fromCard = !!from && rows[0]?.triage_channel === from;
      const desk = from ? await deskByTriageChannel(db, from) : null;
      if (!desk && !fromCard) {
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
      if (rows.length === 0) {
        await restoreClicked(ctx, input);
        return terminate({ skipped: `issue ${issueId.data} not found` });
      }
      // A click from another desk's triage channel is not a decision on this issue, unless the
      // card itself sits there (posted before its desk's channel moved).
      const owner = await deskForIssue(db, { deskId: rows[0].desk_id });
      if (desk && !fromCard && owner.id !== desk.id) {
        ctx.logger.warn(
          "issue action from another desk's triage channel; ignored",
          {
            actionId: action.action_id,
            channel: from,
            desk: desk.slug,
            issueDesk: owner.slug,
            user: clicker,
          },
        );
        await restoreClicked(ctx, input);
        return terminate({
          skipped: `issue ${issueId.data} belongs to desk ${owner.slug}, not ${desk.slug}`,
        });
      }
      const triageChannel = rows[0].triage_channel ?? owner.triageChannel;
      await recordRun(db, ctx, AGENT, issueId.data);
      if (!known)
        return terminate({
          skipped: `unknown issue action ${action.action_id}`,
        });

      if (verb === "handled") {
        const current = await getIssue(db, issueId.data);
        const { issue, applied } = await recordTeamAnswer(ctx, db, {
          issueId: current.id,
          eventId: `handled:${input.trigger_id}`,
          user: clicker,
          userName: input.user.name ?? input.user.username ?? clicker,
          slack: {
            channel: current.customerChannel ?? triageChannel,
            ts: action.action_ts ?? `${Math.floor(Date.now() / 1000)}.000000`,
            ...(current.customerRootTs && {
              threadTs: current.customerRootTs,
            }),
          },
          text: "(marked handled)",
        });
        if (input.container?.message_ts !== issue.triageRootTs)
          await settleClicked(
            ctx,
            input,
            applied ? `Handled by <@${clicker}>` : "Already handled",
          );
        await rescheduleIssue(db, ctx, issue.id);
        return terminate({
          outcome: verb,
          changed: applied,
          issueId: issue.id,
          status: issue.status,
          owner: issue.ownerSlackId,
        });
      }

      if (verb === "resolve") {
        const current = await getIssue(db, issueId.data);
        const moved = await resolveByHand(
          ctx,
          db,
          triageChannel,
          current,
          clicker,
        );
        const issue = moved ?? (await getIssue(db, issueId.data));
        if (moved) await redrawCard(ctx, db, triageChannel, moved);
        else
          await refreshCard(
            ctx,
            db,
            triageChannel,
            issue,
            await getAccount(db, issue.accountId),
          );
        if (input.container?.message_ts !== issue.triageRootTs)
          await settleClicked(
            ctx,
            input,
            moved
              ? `Resolved by <@${clicker}>`
              : `Not On Hold (${issue.status.replace("_", " ")})`,
          );
        await rescheduleIssue(db, ctx, issue.id);
        return terminate({
          outcome: verb,
          changed: Boolean(moved),
          issueId: issue.id,
          status: issue.status,
          owner: issue.ownerSlackId,
        });
      }

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

      try {
        // The click may come from a controller nudge, so the card is always addressed by triage_root_ts.
        const account = await getAccount(db, issue.accountId);
        await refreshCard(ctx, db, triageChannel, issue, account);
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
      } finally {
        // A Slack failure above must not skip it: the retry sees the issue as already closed.
        if (verb === "close" && changed)
          await noteOpenLinear(ctx, triageChannel, issue);
      }
      // Take stops no_owner; Close cancels the timer.
      if (changed) await rescheduleIssue(db, ctx, issue.id);
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
    "Support desk intake: a customer Slack message becomes a classified issue or a follow-up, an issue card in triage, and an issue.* event. Handles Take, Close, Resolved, Handled, the ticket reaction and teammates' reactions, and resets each changed issue's controller timer.",
  entry: "guard",
  steps: {
    guard,
    internal,
    team,
    react: reaction,
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
