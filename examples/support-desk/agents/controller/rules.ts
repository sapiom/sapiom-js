/** Plain rows and an explicit time keep threshold edges and round deduplication testable without a database. */
import type { Direction, DraftStatus, IssueStatus } from "../../_shared/issues";
import { byThreadOrder, slaDeadline, type Sla } from "../../_shared/sla";

export { byThreadOrder, postedAt } from "../../_shared/sla";

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
  /** Picks the issue's target when `RuleInput.sla` is set. */
  priority?: string | null;
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
  sentAt: Date;
}

export interface Nudge {
  issueId: string;
  kind: NudgeKind;
  /** The draft id, the last customer message id, or the issue id. */
  refId: string;
  /** The round, from 1. */
  n: number;
  /** `<kind>:<refId>:<n>`, recorded with `recordNudge`. */
  key: string;
}

export const nudgeKey = (kind: NudgeKind, refId: string, n: number): string =>
  `${kind}:${refId}:${n}`;

/** Omits the round so a no-reply verdict silences every reminder for that message while the Jev check is on. */
export const skipKey = (kind: NudgeKind, refId: string): string =>
  `skip:${kind}:${refId}`;

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
  /** Gap before each repeat round: after round n, `repeatMinutes[n - 1]`; the last gap repeats, `[]` = once. */
  repeatMinutes: readonly number[];
  /** Response targets per priority; when set they replace `minutes` and `deskMinutes`. */
  sla?: Sla | null;
  /**
   * Whether Jev verdicts count (default true). With the check off, a `skip:` record no longer
   * silences `customer_waiting`; each sent round still dedups its own key.
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

// Legacy keys count as round 1 so existing nudge history still controls repeat timing.
function lastRound(
  rows: SentRow[],
  base: string,
): { n: number; sentAt: Date } | undefined {
  let last: { n: number; sentAt: Date } | undefined;
  for (const r of rows) {
    const round =
      r.kind === base
        ? "1"
        : r.kind.startsWith(`${base}:`)
          ? r.kind.slice(base.length + 1)
          : "";
    if (!/^\d+$/.test(round)) continue;
    const n = Number(round);
    if (!last || n > last.n) last = { n, sentAt: r.sentAt };
  }
  return last;
}

/**
 * Every nudge due at `now` and not yet sent. A condition is due once it has held for at least
 * the issue's SLA target (first response until the team has replied once, next response after),
 * or without `sla` its desk's `nudge_minutes`. Closed issues and issues without a triage card
 * (nowhere to post) get none; on-hold issues get no `draft_pending` or `customer_waiting`, since engineering owns the next move.
 */
export function dueNudges(input: RuleInput): Nudge[] {
  const drafts = groupBy(input.drafts);
  const messages = groupBy(input.messages);
  const sent = groupBy(input.sent);
  const jevCheck = input.jevCheck ?? true;
  const due: Nudge[] = [];

  for (const issue of input.issues) {
    if (issue.status === "closed" || !issue.triageRootTs) continue;
    // Internal triage chatter is not a reply to the customer, so only the customer thread counts.
    const thread = (messages.get(issue.id) ?? [])
      .filter((m) => m.direction !== "internal")
      .sort(byThreadOrder);
    const thresholdMs =
      ((issue.deskId ? input.deskMinutes?.[issue.deskId] : undefined) ??
        input.minutes) * 60_000;
    const sla = input.sla;
    const clock = thread.some((m) => m.direction === "agent")
      ? "next_response"
      : "first_response";
    // Only the threshold moves with the SLA; each rule keeps its own start time.
    const old = sla
      ? (t: Date) =>
          input.now.getTime() >=
          slaDeadline(sla, issue.priority, clock, t).getTime()
      : (t: Date) => input.now.getTime() - t.getTime() >= thresholdMs;
    const issueSent = sent.get(issue.id) ?? [];
    const add = (kind: NudgeKind, refId: string) => {
      const skip = skipKey(kind, refId);
      if (jevCheck && issueSent.some((s) => s.kind === skip)) return;
      const last = lastRound(issueSent, `${kind}:${refId}`);
      if (last) {
        const gaps = input.repeatMinutes;
        if (gaps.length === 0) return;
        const gapMs = gaps[Math.min(last.n, gaps.length) - 1] * 60_000;
        if (input.now.getTime() - last.sentAt.getTime() < gapMs) return;
      }
      const n = (last?.n ?? 0) + 1;
      due.push({
        issueId: issue.id,
        kind,
        refId,
        n,
        key: nudgeKey(kind, refId, n),
      });
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

function lastCustomerMessage(messages: MessageRow[]): MessageRow | undefined {
  // Internal triage chatter is not a reply to the customer, so only the customer thread counts.
  const last = messages
    .filter((m) => m.direction !== "internal")
    .sort(byThreadOrder)
    .at(-1);
  return last?.direction === "customer" ? last : undefined;
}

/** SAP-3788 requires paging for missing ownership or a waiting customer. */
export const ESCALATION_KINDS = ["no_owner", "customer_waiting"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/** Recorded in `nudges.kind`: one escalation per issue per level. */
export const escalationKey = (level: number): string => `escalate:${level}`;

export interface Escalation {
  issueId: string;
  deskId: string;
  /** 1-based index into the desk's levels. */
  level: number;
  /** Every escalating condition that holds now, with how long it has held. */
  reasons: { kind: EscalationKind; refId: string; minutes: number }[];
  key: string;
}

export interface EscalationInput {
  issues: IssueRow[];
  messages: MessageRow[];
  /** Escalation reads only which keys were sent, never when. */
  sent: Pick<SentRow, "issueId" | "kind">[];
  now: Date;
  /** Minutes per level, by desk id; a desk not listed never escalates. */
  levels: Readonly<Record<string, readonly number[]>>;
  defaultDeskId?: string | null;
  /** Reuse no-reply verdicts to avoid paging for customer acknowledgements. */
  jevCheck?: boolean;
}

/** Select only the highest due level and suppress previously reached levels to avoid catch-up paging. */
export function dueEscalations(input: EscalationInput): Escalation[] {
  const messages = groupBy(input.messages);
  const sent = groupBy(input.sent);
  const jevCheck = input.jevCheck ?? true;
  const now = input.now.getTime();
  const due: Escalation[] = [];

  for (const issue of input.issues) {
    if (issue.status === "closed" || !issue.triageRootTs) continue;
    const deskId = issue.deskId ?? input.defaultDeskId ?? "";
    const levels = input.levels[deskId];
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
      deskId,
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
