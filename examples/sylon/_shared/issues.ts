/**
 * The only writer of the Sylon tables (except `config`, which `config.ts` owns).
 *
 * Every insert sets `source`. Idempotent inserts select first, then insert with
 * `on conflict do nothing` and reselect when no row came back. Never a caught unique violation:
 * in Postgres that aborts the caller's transaction. The pre-select is what makes pg-mem agree,
 * since its `on conflict do nothing returning` wrongly returns the existing row.
 */
import type { Db, Row } from "./db";
import type { SlackRef } from "./events";

export type IssueStatus =
  "new" | "on_you" | "on_customer" | "on_hold" | "closed";
/** Widen when a new source adapter lands; never a free string. */
export type IssueSource = "slack";
export type Direction = "customer" | "agent" | "internal";
export type DraftStatus =
  "pending" | "approved" | "dismissed" | "escalated" | "superseded";
export type DraftDecision = Exclude<DraftStatus, "pending">;

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  "new",
  "on_you",
  "on_customer",
  "on_hold",
  "closed",
];
export const OPEN_STATUSES: readonly IssueStatus[] = [
  "new",
  "on_you",
  "on_customer",
  "on_hold",
];

export interface Account {
  id: string;
  name: string;
  slackChannelId: string;
  createdAt: Date;
}

export interface Issue {
  id: string;
  number: number;
  accountId: string;
  source: IssueSource;
  status: IssueStatus;
  category: string | null;
  priority: string | null;
  title: string | null;
  summary: string | null;
  customerChannel: string | null;
  customerRootTs: string | null;
  triageRootTs: string | null;
  ownerSlackId: string | null;
  linearIssueId: string | null;
  linearIdentifier: string | null;
  /** 050_linear_url: null for issues escalated before it, and on Linear replies without a URL. */
  linearUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface Message {
  id: string;
  issueId: string | null;
  source: IssueSource;
  sourceEventId: string;
  channel: string | null;
  ts: string | null;
  threadTs: string | null;
  userId: string | null;
  userName: string | null;
  direction: Direction;
  text: string | null;
  jev: unknown;
  createdAt: Date;
}

export interface Draft {
  id: string;
  issueId: string;
  cardChannel: string | null;
  cardTs: string | null;
  text: string;
  citations: unknown;
  /** The event that produced the draft (copilot); null for drafts made without one. */
  causationId: string | null;
  confidence: number | null;
  status: DraftStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

// --- status machine --------------------------------------------------------------------------

/**
 * Legal moves, from design.md "Status machine". A customer message reopens a closed issue;
 * escalation can park any open issue; Close is allowed from anywhere.
 */
export const TRANSITIONS: Readonly<
  Record<IssueStatus, readonly IssueStatus[]>
> = {
  new: ["on_you", "on_customer", "on_hold", "closed"],
  on_you: ["on_customer", "on_hold", "closed"],
  on_customer: ["on_you", "on_hold", "closed"],
  on_hold: ["on_you", "closed"],
  closed: ["on_you"],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly issueId: string,
    readonly from: IssueStatus,
    readonly to: IssueStatus,
  ) {
    super(`issue ${issueId}: illegal status move ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

// --- row mapping -----------------------------------------------------------------------------

const toAccount = (r: Row): Account => ({
  id: r.id as string,
  name: r.name as string,
  slackChannelId: r.slack_channel_id as string,
  createdAt: r.created_at as Date,
});

const toIssue = (r: Row): Issue => ({
  id: r.id as string,
  number: Number(r.number),
  accountId: r.account_id as string,
  source: r.source as IssueSource,
  status: r.status as IssueStatus,
  category: (r.category as string | null) ?? null,
  priority: (r.priority as string | null) ?? null,
  title: (r.title as string | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  customerChannel: (r.customer_channel as string | null) ?? null,
  customerRootTs: (r.customer_root_ts as string | null) ?? null,
  triageRootTs: (r.triage_root_ts as string | null) ?? null,
  ownerSlackId: (r.owner_slack_id as string | null) ?? null,
  linearIssueId: (r.linear_issue_id as string | null) ?? null,
  linearIdentifier: (r.linear_identifier as string | null) ?? null,
  linearUrl: (r.linear_url as string | null) ?? null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
  closedAt: (r.closed_at as Date | null) ?? null,
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  issueId: (r.issue_id as string | null) ?? null,
  source: r.source as IssueSource,
  sourceEventId: r.source_event_id as string,
  channel: (r.channel as string | null) ?? null,
  ts: (r.ts as string | null) ?? null,
  threadTs: (r.thread_ts as string | null) ?? null,
  userId: (r.user_id as string | null) ?? null,
  userName: (r.user_name as string | null) ?? null,
  direction: r.direction as Direction,
  text: (r.text as string | null) ?? null,
  jev: r.jev ?? null,
  createdAt: r.created_at as Date,
});

const toDraft = (r: Row): Draft => ({
  id: r.id as string,
  issueId: r.issue_id as string,
  cardChannel: (r.card_channel as string | null) ?? null,
  cardTs: (r.card_ts as string | null) ?? null,
  text: r.text as string,
  citations: r.citations ?? null,
  causationId: (r.causation_id as string | null) ?? null,
  confidence: r.confidence == null ? null : Number(r.confidence),
  status: r.status as DraftStatus,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: (r.decided_at as Date | null) ?? null,
  createdAt: r.created_at as Date,
});

const json = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${what} not found`);
  return row;
}

// --- accounts --------------------------------------------------------------------------------

/**
 * Create the account for a channel if there is none; never renames. Setup uses this, so a rerun
 * keeps names an onboarding flow has changed. Safe under concurrent first sightings.
 */
export async function ensureAccount(
  db: Db,
  input: { name: string; slackChannelId: string },
): Promise<Account> {
  const found = await accountByChannel(db, input.slackChannelId);
  if (found) return found;
  await db.query(
    "insert into accounts (name, slack_channel_id) values ($1, $2) on conflict (slack_channel_id) do nothing",
    [input.name, input.slackChannelId],
  );
  return one(
    [await accountByChannel(db, input.slackChannelId)].filter(
      (x): x is Account => x !== null,
    ),
    "account",
  );
}

/** Onboarding: create the account, or rename it when it exists. */
export async function upsertAccount(
  db: Db,
  input: { name: string; slackChannelId: string },
): Promise<Account> {
  const account = await ensureAccount(db, input);
  if (account.name === input.name) return account;
  const rows = await db.query(
    "update accounts set name = $2 where id = $1 returning *",
    [account.id, input.name],
  );
  return toAccount(one(rows, "account"));
}

export async function accountByChannel(
  db: Db,
  channel: string,
): Promise<Account | null> {
  const rows = await db.query(
    "select * from accounts where slack_channel_id = $1",
    [channel],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

export async function getAccount(db: Db, id: string): Promise<Account> {
  return toAccount(
    one(
      await db.query("select * from accounts where id = $1", [id]),
      `account ${id}`,
    ),
  );
}

// --- issues ----------------------------------------------------------------------------------

export interface OpenIssueInput {
  accountId: string;
  source: IssueSource;
  category: string;
  priority: string;
  title: string;
  /** The customer message that opened the issue; its thread root is the issue's customer thread. */
  customer: SlackRef;
  triageRootTs?: string;
}

export async function openIssue(db: Db, input: OpenIssueInput): Promise<Issue> {
  const rows = await db.query(
    `insert into issues (account_id, source, status, category, priority, title, customer_channel, customer_root_ts, triage_root_ts)
     values ($1, $2, 'new', $3, $4, $5, $6, $7, $8) returning *`,
    [
      input.accountId,
      input.source,
      input.category,
      input.priority,
      input.title,
      input.customer.channel,
      input.customer.threadTs ?? input.customer.ts,
      input.triageRootTs ?? null,
    ],
  );
  return toIssue(one(rows, "issue"));
}

export async function getIssue(db: Db, id: string): Promise<Issue> {
  return toIssue(
    one(
      await db.query("select * from issues where id = $1", [id]),
      `issue ${id}`,
    ),
  );
}

/** {@link getIssue} under `for update`, for a caller's transaction that decides on the row. */
export async function lockIssue(db: Db, id: string): Promise<Issue> {
  return toIssue(
    one(
      await db.query("select * from issues where id = $1 for update", [id]),
      `issue ${id}`,
    ),
  );
}

/** The issue whose customer thread is rooted at `rootTs` in `channel`, newest first. */
export async function issueByCustomerThread(
  db: Db,
  channel: string,
  rootTs: string,
): Promise<Issue | null> {
  const rows = await db.query(
    "select * from issues where customer_channel = $1 and customer_root_ts = $2 order by created_at desc limit 1",
    [channel, rootTs],
  );
  return rows[0] ? toIssue(rows[0]) : null;
}

/** The issue whose triage card is the thread root `ts` in the triage channel. */
export async function issueByTriageRoot(
  db: Db,
  ts: string,
): Promise<Issue | null> {
  const rows = await db.query(
    "select * from issues where triage_root_ts = $1 limit 1",
    [ts],
  );
  return rows[0] ? toIssue(rows[0]) : null;
}

export async function openIssuesForAccount(
  db: Db,
  accountId: string,
): Promise<Issue[]> {
  const rows = await db.query(
    "select * from issues where account_id = $1 and status <> 'closed' order by created_at desc",
    [accountId],
  );
  return rows.map(toIssue);
}

/** Enforces {@link TRANSITIONS}. Moving to the current status is a no-op, so retries are safe. */
export async function setStatus(
  db: Db,
  issueId: string,
  status: IssueStatus,
): Promise<Issue> {
  return db.transaction(async (tx) => {
    const current = toIssue(
      one(
        await tx.query("select * from issues where id = $1 for update", [
          issueId,
        ]),
        `issue ${issueId}`,
      ),
    );
    if (current.status === status) return current;
    if (!canTransition(current.status, status))
      throw new IllegalTransitionError(issueId, current.status, status);
    const rows = await tx.query(
      `update issues set status = $2, updated_at = now(),
         closed_at = case when $2 = 'closed' then now() else null end
       where id = $1 returning *`,
      [issueId, status],
    );
    return toIssue(one(rows, `issue ${issueId}`));
  });
}

export async function assign(
  db: Db,
  issueId: string,
  ownerSlackId: string,
): Promise<Issue> {
  const rows = await db.query(
    "update issues set owner_slack_id = $2, updated_at = now() where id = $1 returning *",
    [issueId, ownerSlackId],
  );
  return toIssue(one(rows, `issue ${issueId}`));
}

/** Where the issue card was posted in the triage channel; its replies are the triage thread. */
export async function setTriageRoot(
  db: Db,
  issueId: string,
  triageRootTs: string,
): Promise<Issue> {
  const rows = await db.query(
    "update issues set triage_root_ts = $2, updated_at = now() where id = $1 returning *",
    [issueId, triageRootTs],
  );
  return toIssue(one(rows, `issue ${issueId}`));
}

export type IssueFields = Partial<
  Pick<
    Issue,
    | "category"
    | "priority"
    | "title"
    | "summary"
    | "linearIssueId"
    | "linearIdentifier"
    | "linearUrl"
  >
>;

const FIELD_COLUMNS: Record<keyof IssueFields, string> = {
  category: "category",
  priority: "priority",
  title: "title",
  summary: "summary",
  linearIssueId: "linear_issue_id",
  linearIdentifier: "linear_identifier",
  linearUrl: "linear_url",
};

/** Classification, the copilot's summary, and the Linear link. Status changes go through {@link setStatus}. */
export async function updateIssue(
  db: Db,
  issueId: string,
  fields: IssueFields,
): Promise<Issue> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [
    keyof IssueFields,
    string | null,
  ][];
  if (entries.length === 0) return getIssue(db, issueId);
  const sets = entries
    .map(([k], i) => `${FIELD_COLUMNS[k]} = $${i + 2}`)
    .join(", ");
  const rows = await db.query(
    `update issues set ${sets}, updated_at = now() where id = $1 returning *`,
    [issueId, ...entries.map(([, v]) => v)],
  );
  return toIssue(one(rows, `issue ${issueId}`));
}

// --- messages --------------------------------------------------------------------------------

export interface LinkMessageInput {
  issueId?: string;
  source: IssueSource;
  /** Slack `event_id`; the idempotency key, because a retried step re-runs from the top. */
  sourceEventId: string;
  direction: Direction;
  slack: SlackRef;
  userId: string;
  userName?: string;
  text: string;
  jev?: unknown;
}

/** Insert the message once. A second call with the same `sourceEventId` returns the stored row. */
export async function linkMessage(
  db: Db,
  input: LinkMessageInput,
): Promise<{ message: Message; duplicate: boolean }> {
  // In a transaction so pg-mem (serialized transactions) agrees with Postgres under concurrency.
  return db.transaction((tx) => linkMessageIn(tx, input));
}

async function linkMessageIn(
  db: Db,
  input: LinkMessageInput,
): Promise<{ message: Message; duplicate: boolean }> {
  const existing = async () => {
    const rows = await db.query(
      "select * from messages where source_event_id = $1",
      [input.sourceEventId],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  };
  const found = await existing();
  if (found) return { message: found, duplicate: true };
  // `on conflict do nothing` (not a caught unique violation) keeps this safe inside a caller's
  // transaction, where a raised violation would abort it.
  const rows = await db.query(
    `insert into messages (issue_id, source, source_event_id, channel, ts, thread_ts, user_id, user_name, direction, text, jev)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb)
     on conflict (source_event_id) do nothing returning *`,
    [
      input.issueId ?? null,
      input.source,
      input.sourceEventId,
      input.slack.channel,
      input.slack.ts,
      input.slack.threadTs ?? null,
      input.userId,
      input.userName ?? null,
      input.direction,
      input.text,
      json(input.jev),
    ],
  );
  if (rows[0]) return { message: toMessage(rows[0]), duplicate: false };
  // Lost a race with a concurrent run for the same event.
  const winner = await existing();
  return { message: one(winner ? [winner] : [], "message"), duplicate: true };
}

export async function messageBySourceEventId(
  db: Db,
  sourceEventId: string,
): Promise<Message | null> {
  const rows = await db.query(
    "select * from messages where source_event_id = $1",
    [sourceEventId],
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

/**
 * The stored message at `ts` in `channel`, oldest first. A reaction names its message by
 * channel and ts, never by the event id the message was stored under.
 */
export async function messageBySlackTs(
  db: Db,
  channel: string,
  ts: string,
): Promise<Message | null> {
  const rows = await db.query(
    "select * from messages where channel = $1 and ts = $2 order by created_at asc limit 1",
    [channel, ts],
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

/** Attach a message stored before its issue existed (intake persists first, then opens the issue). */
export async function attachMessage(
  db: Db,
  messageId: string,
  issueId: string,
): Promise<Message> {
  const rows = await db.query(
    "update messages set issue_id = $2 where id = $1 returning *",
    [messageId, issueId],
  );
  return toMessage(one(rows, `message ${messageId}`));
}

/**
 * Open an issue for a stored message exactly once. The message row is locked, so two runs for the
 * same message (a retry overlapping a slow first attempt) agree on one issue: the second gets the
 * first's issue with `created: false`.
 */
export async function openIssueForMessage(
  db: Db,
  messageId: string,
  input: OpenIssueInput,
): Promise<{ issue: Issue; created: boolean }> {
  return db.transaction(async (tx) => {
    const message = toMessage(
      one(
        await tx.query("select * from messages where id = $1 for update", [
          messageId,
        ]),
        `message ${messageId}`,
      ),
    );
    if (message.issueId) {
      return { issue: await getIssue(tx, message.issueId), created: false };
    }
    const issue = await openIssue(tx, input);
    await attachMessage(tx, messageId, issue.id);
    return { issue, created: true };
  });
}

/** Slack `ts` of the newest customer message on the issue, or null when it has none. */
export async function latestCustomerTs(
  db: Db,
  issueId: string,
): Promise<string | null> {
  const rows = await db.query(
    "select ts from messages where issue_id = $1 and direction = 'customer' and ts is not null",
    [issueId],
  );
  let latest: string | null = null;
  for (const r of rows) {
    const ts = String(r.ts);
    if (latest === null || compareSlackTs(ts, latest) > 0) latest = ts;
  }
  return latest;
}

/** Numeric order of two Slack timestamps ("seconds.micros"); exact, since a double cannot hold 16 digits safely. */
export function compareSlackTs(a: string, b: string): number {
  const norm = (ts: string) => {
    const [sec = "0", frac = ""] = ts.split(".");
    return BigInt(sec + frac.padEnd(6, "0").slice(0, 6));
  };
  const x = norm(a);
  const y = norm(b);
  return x === y ? 0 : x > y ? 1 : -1;
}

export async function messagesForIssue(
  db: Db,
  issueId: string,
): Promise<Message[]> {
  const rows = await db.query(
    "select * from messages where issue_id = $1 order by created_at asc",
    [issueId],
  );
  return rows.map(toMessage);
}

// --- drafts ----------------------------------------------------------------------------------

export async function createDraft(
  db: Db,
  input: {
    issueId: string;
    text: string;
    citations?: unknown;
    cardChannel?: string;
    cardTs?: string;
    causationId?: string;
    confidence?: number;
  },
): Promise<Draft> {
  const rows = await db.query(
    `insert into drafts (issue_id, text, citations, card_channel, card_ts, causation_id, confidence, status)
     values ($1, $2, $3::text::jsonb, $4, $5, $6, $7, 'pending') returning *`,
    [
      input.issueId,
      input.text,
      json(input.citations),
      input.cardChannel ?? null,
      input.cardTs ?? null,
      input.causationId ?? null,
      input.confidence ?? null,
    ],
  );
  return toDraft(one(rows, "draft"));
}

/**
 * Insert the draft for `causationId` once. Two concurrent runs for the same event both miss the
 * pre-select; the unique `(issue_id, causation_id)` index lets one insert win, and the other gets
 * the winner's row with `created: false`.
 */
export async function createDraftOnce(
  db: Db,
  input: {
    issueId: string;
    text: string;
    citations?: unknown;
    causationId: string;
    confidence?: number;
  },
): Promise<{ draft: Draft; created: boolean }> {
  // In a transaction so pg-mem (serialized transactions) agrees with Postgres under concurrency.
  return db.transaction(async (tx) => {
    const found = await draftForCausation(tx, input.issueId, input.causationId);
    if (found) return { draft: found, created: false };
    const rows = await tx.query(
      `insert into drafts (issue_id, text, citations, causation_id, confidence, status)
       values ($1, $2, $3::text::jsonb, $4, $5, 'pending')
       on conflict (issue_id, causation_id) do nothing returning *`,
      [
        input.issueId,
        input.text,
        json(input.citations),
        input.causationId,
        input.confidence ?? null,
      ],
    );
    if (rows[0]) return { draft: toDraft(rows[0]), created: true };
    const winner = await draftForCausation(
      tx,
      input.issueId,
      input.causationId,
    );
    return { draft: one(winner ? [winner] : [], "draft"), created: false };
  });
}

/** Where the draft card was posted, once it has been. */
export async function setDraftCard(
  db: Db,
  draftId: string,
  card: { channel: string; ts: string },
): Promise<Draft> {
  const rows = await db.query(
    "update drafts set card_channel = $2, card_ts = $3 where id = $1 returning *",
    [draftId, card.channel, card.ts],
  );
  return toDraft(one(rows, `draft ${draftId}`));
}

export async function getDraft(db: Db, draftId: string): Promise<Draft> {
  return toDraft(
    one(
      await db.query("select * from drafts where id = $1", [draftId]),
      `draft ${draftId}`,
    ),
  );
}

export async function pendingDrafts(db: Db, issueId: string): Promise<Draft[]> {
  const rows = await db.query(
    "select * from drafts where issue_id = $1 and status = 'pending' order by created_at asc",
    [issueId],
  );
  return rows.map(toDraft);
}

/**
 * The draft an event already produced, so a retried drafting step reuses it instead of adding a
 * second card. Any status: a retry must not redraft what a teammate already decided.
 */
export async function draftForCausation(
  db: Db,
  issueId: string,
  causationId: string,
): Promise<Draft | null> {
  const rows = await db.query(
    "select * from drafts where issue_id = $1 and causation_id = $2 order by created_at desc limit 1",
    [issueId, causationId],
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

/**
 * Decide a pending draft under a row lock. Two quick clicks are two runs; the second sees a
 * non-pending row and gets `changed: false` with the first decision, so it does nothing.
 */
export async function decideDraft(
  db: Db,
  draftId: string,
  decision: DraftDecision,
  by: string,
): Promise<{ draft: Draft; changed: boolean }> {
  return db.transaction(async (tx) => {
    const current = toDraft(
      one(
        await tx.query("select * from drafts where id = $1 for update", [
          draftId,
        ]),
        `draft ${draftId}`,
      ),
    );
    if (current.status !== "pending") return { draft: current, changed: false };
    const rows = await tx.query(
      "update drafts set status = $2, decided_by = $3, decided_at = now() where id = $1 returning *",
      [draftId, decision, by],
    );
    return { draft: toDraft(one(rows, `draft ${draftId}`)), changed: true };
  });
}

// --- nudges, runs, events_log ----------------------------------------------------------------

/** `false` when this `(issue, kind)` nudge was already sent. */
export async function recordNudge(
  db: Db,
  issueId: string,
  kind: string,
): Promise<boolean> {
  return db.transaction((tx) => recordNudgeIn(tx, issueId, kind));
}

async function recordNudgeIn(
  db: Db,
  issueId: string,
  kind: string,
): Promise<boolean> {
  const seen = await db.query(
    "select 1 from nudges where issue_id = $1 and kind = $2",
    [issueId, kind],
  );
  if (seen.length > 0) return false;
  const rows = await db.query(
    "insert into nudges (issue_id, kind) values ($1, $2) on conflict (issue_id, kind) do nothing returning kind",
    [issueId, kind],
  );
  return rows.length > 0;
}

/** Every agent records its execution on its first step, so the board can sum cost per issue. */
export async function recordRun(
  db: Db,
  ctx: { executionId: string },
  agent: string,
  issueId?: string,
): Promise<void> {
  // One statement, so a concurrent first record cannot drop the issue link. A later call fills in
  // the issue; it never overwrites one.
  await db.query(
    `insert into runs (execution_id, issue_id, agent) values ($1, $2, $3)
     on conflict (execution_id) do update set issue_id = coalesce(runs.issue_id, excluded.issue_id)`,
    [ctx.executionId, issueId ?? null, agent],
  );
}

export async function logEvent(
  db: Db,
  input: {
    type: string;
    payload: unknown;
    emittedBy: string;
    receiptId?: string | null;
  },
): Promise<void> {
  await db.query(
    "insert into events_log (type, payload, emitted_by, receipt_id) values ($1, $2::text::jsonb, $3, $4)",
    [
      input.type,
      JSON.stringify(input.payload),
      input.emittedBy,
      input.receiptId ?? null,
    ],
  );
}

/** Whether `emit.ts` logged an event of `type` for `causationId` (a step that emitted has finished its writes). */
export async function eventLogged(
  db: Db,
  type: string,
  causationId: string,
): Promise<boolean> {
  const rows = await db.query(
    "select 1 from events_log where type = $1 and payload->>'causationId' = $2 limit 1",
    [type, causationId],
  );
  return rows.length > 0;
}
