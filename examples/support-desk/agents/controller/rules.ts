/** Plain rows and an explicit time keep threshold edges and round deduplication testable without a database. */
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

/** Engineering owns the next move on hold, so suppress draft and customer follow-ups there. */
export function dueNudges(input: RuleInput): Nudge[] {
  const drafts = groupBy(input.drafts);
  const messages = groupBy(input.messages);
  const sent = groupBy(input.sent);
  const jevCheck = input.jevCheck ?? true;
  const due: Nudge[] = [];

  for (const issue of input.issues) {
    if (issue.status === "closed" || !issue.triageRootTs) continue;
    const thresholdMs =
      ((issue.deskId ? input.deskMinutes?.[issue.deskId] : undefined) ??
        input.minutes) * 60_000;
    const old = (t: Date) => input.now.getTime() - t.getTime() >= thresholdMs;
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

    // Internal triage chatter is not a reply to the customer, so only the customer thread counts.
    const last = (messages.get(issue.id) ?? [])
      .filter((m) => m.direction !== "internal")
      .sort(byThreadOrder)
      .at(-1);
    if (!onHold && last?.direction === "customer" && old(last.createdAt))
      add("customer_waiting", last.id);
  }
  return due;
}
