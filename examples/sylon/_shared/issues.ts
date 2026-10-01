/**
 * The only writer of the Sylon tables (except `config`, which `config.ts` owns).
 *
 * Every insert sets `source`. Duplicate detection is select-then-insert inside a transaction with
 * a unique-violation fallback, rather than `on conflict do nothing returning`, so it behaves the
 * same on Postgres and pg-mem.
 */
import type { Db, Row } from "./db";
import { isUniqueViolation } from "./db";
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

/** Setup and onboarding: one account per customer channel. Renames on a second call. */
export async function upsertAccount(
  db: Db,
  input: { name: string; slackChannelId: string },
): Promise<Account> {
  return db.transaction(async (tx) => {
    const found = await tx.query(
      "select * from accounts where slack_channel_id = $1",
      [input.slackChannelId],
    );
    if (found[0]) {
      const rows = await tx.query(
        "update accounts set name = $2 where id = $1 returning *",
        [found[0].id, input.name],
      );
      return toAccount(one(rows, "account"));
    }
    const rows = await tx.query(
      "insert into accounts (name, slack_channel_id) values ($1, $2) returning *",
      [input.name, input.slackChannelId],
    );
    return toAccount(one(rows, "account"));
  });
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
  >
>;

const FIELD_COLUMNS: Record<keyof IssueFields, string> = {
  category: "category",
  priority: "priority",
  title: "title",
  summary: "summary",
  linearIssueId: "linear_issue_id",
  linearIdentifier: "linear_identifier",
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
  const existing = async () => {
    const rows = await db.query(
      "select * from messages where source_event_id = $1",
      [input.sourceEventId],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  };
  const found = await existing();
  if (found) return { message: found, duplicate: true };
  try {
    const rows = await db.query(
      `insert into messages (issue_id, source, source_event_id, channel, ts, thread_ts, user_id, user_name, direction, text, jev)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb) returning *`,
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
    return { message: toMessage(one(rows, "message")), duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return {
      message: one(
        [await existing()].filter((m): m is Message => m !== null),
        "message",
      ),
      duplicate: true,
    };
  }
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
  },
): Promise<Draft> {
  const rows = await db.query(
    `insert into drafts (issue_id, text, citations, card_channel, card_ts, status)
     values ($1, $2, $3::text::jsonb, $4, $5, 'pending') returning *`,
    [
      input.issueId,
      input.text,
      json(input.citations),
      input.cardChannel ?? null,
      input.cardTs ?? null,
    ],
  );
  return toDraft(one(rows, "draft"));
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
  const seen = await db.query(
    "select 1 from nudges where issue_id = $1 and kind = $2",
    [issueId, kind],
  );
  if (seen.length > 0) return false;
  try {
    await db.query("insert into nudges (issue_id, kind) values ($1, $2)", [
      issueId,
      kind,
    ]);
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Every agent records its execution on its first step, so the board can sum cost per issue. */
export async function recordRun(
  db: Db,
  ctx: { executionId: string },
  agent: string,
  issueId?: string,
): Promise<void> {
  const seen = await db.query<{ issue_id: string | null }>(
    "select issue_id from runs where execution_id = $1",
    [ctx.executionId],
  );
  if (seen[0]) {
    // A later step learned the issue: fill it in, never overwrite.
    if (issueId && !seen[0].issue_id) {
      await db.query("update runs set issue_id = $2 where execution_id = $1", [
        ctx.executionId,
        issueId,
      ]);
    }
    return;
  }
  try {
    await db.query(
      "insert into runs (execution_id, issue_id, agent) values ($1, $2, $3)",
      [ctx.executionId, issueId ?? null, agent],
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
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
