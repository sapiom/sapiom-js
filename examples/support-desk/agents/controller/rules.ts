/**
 * The controller's follow-up rules: a pure function over plain rows and `now`, so every threshold
 * edge and the dedup are unit-testable without a database or a clock.
 *
 * Each nudge carries a dedup key `<kind>:<refId>` that the agent records in `nudges.kind`. The ref
 * is the thing the nudge is about (the pending draft, the last customer message, or the issue), so
 * a new draft or a new customer message re-arms its rule while a repeat run stays silent.
 */
import type { Direction, DraftStatus, IssueStatus } from "../../_shared/issues";

/** The kinds `_shared/blocks.ts` `nudge()` labels. */
export const NUDGE_KINDS = [
  "no_owner",
  "no_draft",
  "draft_pending",
  "customer_waiting",
] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

export interface IssueRow {
  id: string;
  status: IssueStatus;
  ownerSlackId: string | null;
  triageRootTs: string | null;
  /** The issue's desk, which sets its threshold in `RuleInput.deskMinutes`. */
  deskId?: string | null;
  createdAt: Date;
}

export interface DraftRow {
  id: string;
  issueId: string;
  status: DraftStatus;
  createdAt: Date;
}

export interface MessageRow {
  id: string;
  issueId: string;
  direction: Direction;
  text: string | null;
  /** Slack `ts`: when the message was posted, which a delayed or replayed event cannot move. */
  ts: string | null;
  /** When it was stored; the clock for how long it has waited. */
  createdAt: Date;
}

/** A `nudges` row: `kind` holds the dedup key. */
export interface SentRow {
  issueId: string;
  kind: string;
}

export interface Nudge {
  issueId: string;
  kind: NudgeKind;
  /** The draft id, the last customer message id, or the issue id. */
  refId: string;
  /** `<kind>:<refId>`, recorded with `recordNudge`. */
  key: string;
}

export const nudgeKey = (kind: NudgeKind, refId: string): string =>
  `${kind}:${refId}`;

/**
 * Recorded when the Jev check decides the customer's last message expects no reply, so later runs
 * neither nudge nor ask Jev again about the same message.
 */
export const skipKey = (kind: NudgeKind, refId: string): string =>
  `skip:${nudgeKey(kind, refId)}`;

export interface RuleInput {
  issues: IssueRow[];
  drafts: DraftRow[];
  messages: MessageRow[];
  sent: SentRow[];
  now: Date;
  /** How long a condition must hold before it is nudged, for an issue whose desk is not in `deskMinutes`. */
  minutes: number;
  /** Each desk's `nudge_minutes`, by desk id. */
  deskMinutes?: Readonly<Record<string, number>>;
  /**
   * Whether Jev verdicts count (default true). With the check off, a `skip:` record no longer
   * silences `customer_waiting`; keys of nudges actually sent always do.
   */
  jevCheck?: boolean;
}

function groupBy<T extends { issueId: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.issueId);
    if (list) list.push(row);
    else out.set(row.issueId, [row]);
  }
  return out;
}

const newest = <T extends { createdAt: Date }>(rows: T[]): T | undefined =>
  rows.reduce<T | undefined>(
    (best, r) =>
      !best || r.createdAt.getTime() > best.createdAt.getTime() ? r : best,
    undefined,
  );

/**
 * Thread order: by Slack `ts`, so an event stored late still sorts where it was posted. Falls back
 * to the insert time only for a message without a `ts`.
 */
export function postedAt(m: MessageRow): number {
  const ts = m.ts === null ? NaN : Number(m.ts);
  return Number.isFinite(ts) ? ts * 1000 : m.createdAt.getTime();
}

export const byThreadOrder = (a: MessageRow, b: MessageRow): number =>
  postedAt(a) - postedAt(b);

/**
 * Every nudge due at `now` and not yet sent. A condition is due once it has held for at least
 * its desk's `nudge_minutes`. Closed issues and issues without a triage card (nowhere to post) get none; on-hold
 * issues get no `draft_pending` or `customer_waiting`, since engineering owns the next move.
 */
export function dueNudges(input: RuleInput): Nudge[] {
  const drafts = groupBy(input.drafts);
  const messages = groupBy(input.messages);
  const sent = new Set(input.sent.map((s) => `${s.issueId} ${s.kind}`));
  const jevCheck = input.jevCheck ?? true;
  const due: Nudge[] = [];

  for (const issue of input.issues) {
    if (issue.status === "closed" || !issue.triageRootTs) continue;
    const thresholdMs =
      ((issue.deskId ? input.deskMinutes?.[issue.deskId] : undefined) ??
        input.minutes) * 60_000;
    const old = (t: Date) => input.now.getTime() - t.getTime() >= thresholdMs;
    const add = (kind: NudgeKind, refId: string) => {
      const key = nudgeKey(kind, refId);
      if (sent.has(`${issue.id} ${key}`)) return;
      if (jevCheck && sent.has(`${issue.id} ${skipKey(kind, refId)}`)) return;
      due.push({ issueId: issue.id, kind, refId, key });
    };
    const onHold = issue.status === "on_hold";
    const issueDrafts = drafts.get(issue.id) ?? [];

    if (!issue.ownerSlackId && old(issue.createdAt)) add("no_owner", issue.id);

    if (issueDrafts.length === 0 && old(issue.createdAt))
      add("no_draft", issue.id);

    const pending = newest(issueDrafts.filter((d) => d.status === "pending"));
    if (!onHold && pending && old(pending.createdAt))
      add("draft_pending", pending.id);

    const last = lastCustomerMessage(messages.get(issue.id) ?? []);
    if (!onHold && last && old(last.createdAt))
      add("customer_waiting", last.id);
  }
  return due;
}

/** The customer's message when it is the last word in the customer thread, else undefined. */
function lastCustomerMessage(messages: MessageRow[]): MessageRow | undefined {
  // Internal triage chatter is not a reply to the customer, so only the customer thread counts.
  const last = messages
    .filter((m) => m.direction !== "internal")
    .sort(byThreadOrder)
    .at(-1);
  return last?.direction === "customer" ? last : undefined;
}

// --- escalation to a person (SAP-3788) ------------------------------------------------------

/** The nudge conditions that escalate to a person once they have held long enough. */
export const ESCALATION_KINDS = ["no_owner", "customer_waiting"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/** Recorded in `nudges.kind`: one escalation per issue per level. */
export const escalationKey = (level: number): string => `escalate:${level}`;

export interface Escalation {
  issueId: string;
  /** 1-based index into the desk's levels. */
  level: number;
  /** Every escalating condition that holds now, with how long it has held. */
  reasons: { kind: EscalationKind; refId: string; minutes: number }[];
  key: string;
}

export interface EscalationInput {
  issues: IssueRow[];
  messages: MessageRow[];
  sent: SentRow[];
  now: Date;
  /** Minutes per level, by desk id; a desk not listed never escalates. */
  levels: Readonly<Record<string, readonly number[]>>;
  /** The desk whose levels apply to an issue without one. */
  defaultDeskId?: string | null;
  /** Whether Jev `skip:customer_waiting:<msgId>` verdicts count (default true). */
  jevCheck?: boolean;
}

/**
 * The escalation due for each issue at `now`. The stall age is the age of the oldest condition
 * that holds; only the highest level it reaches is due, and only when no level at or above it was
 * sent, so a controller that was off does not send level 1 then level 2, and a condition coming
 * back never repeats a level. Same skips as {@link dueNudges}.
 */
export function dueEscalations(input: EscalationInput): Escalation[] {
  const messages = groupBy(input.messages);
  const sent = groupBy(input.sent);
  const jevCheck = input.jevCheck ?? true;
  const now = input.now.getTime();
  const due: Escalation[] = [];

  for (const issue of input.issues) {
    if (issue.status === "closed" || !issue.triageRootTs) continue;
    const levels = input.levels[issue.deskId ?? input.defaultDeskId ?? ""];
    if (!levels?.length) continue;
    const issueSent = new Set((sent.get(issue.id) ?? []).map((s) => s.kind));

    const holding: { kind: EscalationKind; refId: string; since: Date }[] = [];
    if (!issue.ownerSlackId)
      holding.push({
        kind: "no_owner",
        refId: issue.id,
        since: issue.createdAt,
      });
    const last = lastCustomerMessage(messages.get(issue.id) ?? []);
    if (
      issue.status !== "on_hold" &&
      last &&
      !(jevCheck && issueSent.has(skipKey("customer_waiting", last.id)))
    )
      holding.push({
        kind: "customer_waiting",
        refId: last.id,
        since: last.createdAt,
      });
    if (holding.length === 0) continue;

    const ageMs = now - Math.min(...holding.map((h) => h.since.getTime()));
    let level = 0;
    levels.forEach((m, i) => {
      if (ageMs >= m * 60_000) level = i + 1;
    });
    if (level === 0) continue;
    const sentLevels = [...issueSent]
      .filter((k) => k.startsWith("escalate:"))
      .map((k) => Number(k.slice("escalate:".length)));
    if (sentLevels.some((l) => l >= level)) continue;

    due.push({
      issueId: issue.id,
      level,
      reasons: holding.map((h) => ({
        kind: h.kind,
        refId: h.refId,
        minutes: Math.floor((now - h.since.getTime()) / 60_000),
      })),
      key: escalationKey(level),
    });
  }
  return due;
}
