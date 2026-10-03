/** On-hold issues have no response clock because engineering owns the next move. */
import { getConfigOr, minuteOfDay, type ConfigValue } from "./config";
import type { Db } from "./db";
import {
  messagesForIssue,
  type Direction,
  type Issue,
  type IssueStatus,
} from "./issues";

export type Sla = ConfigValue<"sla">;
export type BusinessHours = Sla["businessHours"];
export type SlaPriority = keyof Sla["targets"];
export type SlaKind = "first_response" | "next_response";

export interface SlaDue {
  kind: SlaKind;
  startedAt: Date;
  dueAt: Date;
}

export interface SlaMessage {
  direction: Direction;
  /** Slack `ts`: when the message was posted, which a delayed or replayed event cannot move. */
  ts: string | null;
  /** When it was stored; the clock for how long it has waited. */
  createdAt: Date;
}

// Prefer Slack posting time so delayed events keep thread order; missing or non-finite
// timestamps use insertion time.
export function postedAt(m: Pick<SlaMessage, "ts" | "createdAt">): number {
  const ts = m.ts === null ? NaN : Number(m.ts);
  return Number.isFinite(ts) ? ts * 1000 : m.createdAt.getTime();
}

export const byThreadOrder = (
  a: Pick<SlaMessage, "ts" | "createdAt">,
  b: Pick<SlaMessage, "ts" | "createdAt">,
): number => postedAt(a) - postedAt(b);

/**
 * Walk bound for {@link addBusinessMinutes}; the schema's limits keep every accepted config far
 * below it.
 */
export const MAX_STEPS = 5000;

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

// Encode local calendar fields as UTC so weekdays and window boundaries share one arithmetic frame.
function wall(ms: number, timeZone: string): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(ms)) p[part.type] = Number(part.value);
  return (
    Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) +
    (((ms % 1000) + 1000) % 1000)
  );
}

/** The first instant in `(lo, hi]` whose UTC offset is not `offset`; `hi` must have another one. */
function offsetChange(
  lo: number,
  hi: number,
  offset: number,
  timeZone: string,
): number {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wall(mid, timeZone) - mid === offset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Split at window edges and UTC-offset changes so DST counts elapsed business minutes correctly.
 */
export function addBusinessMinutes(
  start: Date,
  minutes: number,
  hours: BusinessHours,
  maxSteps = MAX_STEPS,
): Date {
  const open = minuteOfDay(hours.start);
  const close = minuteOfDay(hours.end);
  const days = new Set(hours.days);
  const zone = hours.timeZone;
  let t = start.getTime();
  let left = minutes * 60_000;
  for (let step = 0; step < maxSteps; step++) {
    const local = wall(t, zone);
    const offset = local - t;
    const businessDay = days.has(new Date(local).getUTCDay());
    const minute = (((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000;
    const inside = businessDay && minute >= open && minute < close;
    const edge = inside ? close : businessDay && minute < open ? open : 1440;
    let next = Math.round(t + (edge - minute) * 60_000);
    if (wall(next, zone) - next !== offset)
      next = offsetChange(t, next, offset, zone);
    if (inside) {
      if (left <= next - t) return new Date(t + left);
      left -= next - t;
    }
    t = next;
  }
  throw new Error(
    `addBusinessMinutes: no result within ${maxSteps} steps (${minutes} minutes in ${zone})`,
  );
}

// Keep the fallback aligned with intake's normal priority; own keys only, so an inherited name
// such as `toString` falls back too.
export function slaTarget(sla: Sla, priority: string | null | undefined) {
  return priority && Object.hasOwn(sla.targets, priority)
    ? sla.targets[priority as SlaPriority]
    : sla.targets.normal;
}

export function slaDeadline(
  sla: Sla,
  priority: string | null | undefined,
  kind: SlaKind,
  start: Date,
): Date {
  const target = slaTarget(sla, priority);
  const minutes =
    kind === "first_response"
      ? target.firstResponseMinutes
      : target.nextResponseMinutes;
  return target.businessHours
    ? addBusinessMinutes(start, minutes, sla.businessHours)
    : new Date(start.getTime() + minutes * 60_000);
}

export function slaDue(
  issue: {
    status: IssueStatus;
    priority: string | null;
    createdAt: Date;
    messages: readonly SlaMessage[];
  },
  sla: Sla,
): SlaDue | null {
  if (issue.status === "closed" || issue.status === "on_hold") return null;
  // Internal triage chatter is not a reply to the customer, so only the customer thread counts.
  const thread = issue.messages
    .filter((m) => m.direction !== "internal")
    .sort(byThreadOrder);
  if (!thread.some((m) => m.direction === "agent")) {
    const startedAt = issue.createdAt;
    return {
      kind: "first_response",
      startedAt,
      dueAt: slaDeadline(sla, issue.priority, "first_response", startedAt),
    };
  }
  const last = thread.at(-1)!;
  if (last.direction !== "customer") return null;
  return {
    kind: "next_response",
    startedAt: last.createdAt,
    dueAt: slaDeadline(sla, issue.priority, "next_response", last.createdAt),
  };
}

export async function issueSla(db: Db, issue: Issue): Promise<SlaDue | null> {
  const sla = await getConfigOr(db, "sla", null);
  if (!sla) return null;
  return slaDue(
    { ...issue, messages: await messagesForIssue(db, issue.id) },
    sla,
  );
}
