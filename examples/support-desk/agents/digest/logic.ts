/**
 * The pure half of the digest: SLA per priority, issue age, and the Slack message for one desk.
 * No I/O, so the grouping, ordering and size limits are unit-tested (`digest.test.ts`).
 */
import { escapeMrkdwn, statusLabel } from "../../_shared/blocks";
import { OPEN_STATUSES, type IssueStatus } from "../../_shared/issues";
import type { Block } from "../../_shared/slack";

export const DEFAULT_SLA_HOURS = { urgent: 4, high: 24, normal: 72, low: 168 };
export type SlaHours = typeof DEFAULT_SLA_HOURS;

/** Slack's limits: characters in a section's text, blocks in a message. */
export const MAX_SECTION_CHARS = 3000;
export const MAX_BLOCKS = 50;
// Each free-text field is cut before escaping, so a line always fits a section with its alerts.
const FIELD_MAX = 100;
const field = (text: string) => escapeMrkdwn(text.slice(0, FIELD_MAX));

export interface DigestIssue {
  number: number;
  status: IssueStatus;
  priority: string | null;
  title: string | null;
  accountName: string;
  /** The account's Slack channel: an account named after it shows as `#channel-name`. */
  accountChannel?: string | null;
  ownerSlackId: string | null;
  createdAt: Date;
  /** Where the line's Open button goes: the customer's message, else the triage card. */
  url?: string | null;
}

/** The statuses where the ball is with the team; only these can be past SLA. */
export const ON_TEAM: readonly IssueStatus[] = ["new", "on_you"];

/** `@U096M2LJEM7` in a stored title (mentions are kept inert) as `@Ilan`, when the name is known. */
export function nameIds(
  text: string,
  names: ReadonlyMap<string, string>,
): string {
  return text.replace(/@([UW][A-Z0-9]{6,})\b/g, (whole, id: string) =>
    names.has(id) ? `@${names.get(id)}` : whole,
  );
}

/** The user ids a title mentions, for {@link nameIds}. */
export function idsIn(text: string | null): string[] {
  return text
    ? [...text.matchAll(/@([UW][A-Z0-9]{6,})\b/g)].map((m) => m[1])
    : [];
}

/**
 * An account named after its channel id (an unlisted channel's account) shows as Slack's channel
 * link, which renders the channel's name and notifies nobody.
 */
function accountLabel(i: DigestIssue): string {
  return i.accountChannel && i.accountName === i.accountChannel
    ? `<#${i.accountChannel}>`
    : field(i.accountName);
}

/** A priority the table does not know (or none) counts as `normal`, as intake defaults it. */
export function slaHoursFor(priority: string | null, table: SlaHours): number {
  return priority && Object.hasOwn(table, priority)
    ? table[priority as keyof SlaHours]
    : table.normal;
}

/** The `YYYY-MM-DD` date of `at` in the IANA zone `timeZone`. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours >= 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : `${hours}h ${minutes % 60}m`;
}

interface Ranked extends DigestIssue {
  pastSla: boolean;
}

// Prioritize overdue issues so truncation drops them last.
const byUrgency = (a: Ranked, b: Ranked) =>
  Number(b.pastSla) - Number(a.pastSla) ||
  a.createdAt.getTime() - b.createdAt.getTime();

const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

export function digestMessage(input: {
  desk: { name: string; triageChannel: string };
  issues: DigestIssue[];
  /** Keep owners identifiable when their display names are unavailable. */
  owners: ReadonlyMap<string, string>;
  now: Date;
  day: string;
  sla: SlaHours;
  maxChars?: number;
  maxBlocks?: number;
}): { text: string; blocks: Block[] } {
  const { desk, owners, now, sla } = input;
  const maxChars = input.maxChars ?? MAX_SECTION_CHARS;
  const maxBlocks = input.maxBlocks ?? MAX_BLOCKS;
  const ranked: Ranked[] = input.issues
    .filter((i) => OPEN_STATUSES.includes(i.status))
    .map((i) => ({
      ...i,
      // Waiting on the customer or on engineering is not the team being late.
      pastSla:
        ON_TEAM.includes(i.status) &&
        now.getTime() - i.createdAt.getTime() >=
          slaHoursFor(i.priority, sla) * 3600_000,
    }))
    .sort(byUrgency);
  const past = ranked.filter((i) => i.pastSla).length;
  const deskName = escapeMrkdwn(desk.name);
  const summary = ranked.length
    ? `${ranked.length} open, ${past} past SLA`
    : "No open issues.";
  const header = section(
    `*Daily digest · ${deskName} · ${input.day}*\n${summary}`,
  );
  const text = `Daily digest for ${deskName}: ${summary}`;

  const line = (i: Ranked) => {
    // Plain text: Slack attaches a preview to a link in the text (a frozen copy of the card or of
    // the customer's message), so the link is the line's Open button instead.
    const ref = `#${i.number}`;
    const title = field(nameIds(i.title ?? "(untitled)", owners));
    const owner = i.ownerSlackId
      ? field(owners.get(i.ownerSlackId) ?? i.ownerSlackId)
      : "unassigned";
    const parts = [
      `${ref} ${accountLabel(i)}: ${title}`,
      formatAge(now.getTime() - i.createdAt.getTime()),
      owner,
    ];
    if (i.pastSla) parts.push("*past SLA*");
    return parts.join(" · ");
  };

  /** One issue per section, so each carries its own Open button. */
  const item = (i: Ranked): Block => {
    const block = section(line(i).slice(0, maxChars));
    if (i.url)
      block.accessory = {
        type: "button",
        action_id: "digest.open",
        text: { type: "plain_text", text: "Open" },
        url: i.url,
      };
    return block;
  };

  // Match the Console's status order so readers can compare the digest with the board.
  const layout = (list: Ranked[]): Block[] => {
    const out: Block[] = [];
    for (const status of OPEN_STATUSES) {
      const group = list.filter((i) => i.status === status);
      if (!group.length) continue;
      out.push(section(`*${statusLabel(status)} (${group.length})*`));
      for (const i of group) out.push(item(i));
    }
    return out;
  };

  const full = layout(ranked);
  if (1 + full.length <= maxBlocks) return { text, blocks: [header, ...full] };

  // Too many to list: keep the most urgent `k` that fit beside the header and the `+n more` line.
  // More issues never need fewer blocks, so the largest such `k` is found by bisection.
  let lo = 0;
  let hi = ranked.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (layout(ranked.slice(0, mid)).length + 2 <= maxBlocks) lo = mid;
    else hi = mid - 1;
  }
  return {
    text,
    blocks: [
      header,
      ...layout(ranked.slice(0, lo)),
      section(`+${ranked.length - lo} more open issues, see the Console`),
    ],
  };
}
