/**
 * Response targets per priority (the `sla` config key): which clock runs for an issue and when it
 * breaches. Pure functions over plain rows, plus {@link issueSla} for callers holding a `Db`.
 *
 * - first response: no `agent` message yet; the clock starts when the issue opened.
 * - next response: the team has replied once and the customer spoke last; the clock starts at
 *   that customer message.
 * - none: the team spoke last, or the issue is closed or on hold (engineering owns the next move).
 */
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

/** What {@link slaDue} reads of a message. */
export interface SlaMessage {
  direction: Direction;
  /** Slack `ts`: when the message was posted, which a delayed or replayed event cannot move. */
  ts: string | null;
  /** When it was stored; the clock for how long it has waited. */
  createdAt: Date;
}

/**
 * Thread order: by Slack `ts`, so an event stored late still sorts where it was posted. Falls back
 * to the insert time only for a message without a `ts`.
 */
export function postedAt(m: Pick<SlaMessage, "ts" | "createdAt">): number {
  const ts = m.ts === null ? NaN : Number(m.ts);
  return Number.isFinite(ts) ? ts * 1000 : m.createdAt.getTime();
}

export const byThreadOrder = (
  a: Pick<SlaMessage, "ts" | "createdAt">,
  b: Pick<SlaMessage, "ts" | "createdAt">,
): number => postedAt(a) - postedAt(b);

/** Walk bound for {@link addBusinessMinutes}; the schema's limits keep every accepted config far below it. */
export const MAX_STEPS = 5000;

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The local weekday and minute of day (with its fraction) of `ms` in `timeZone`. */
function localTime(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  const part: Record<string, string> = {};
  for (const p of f.formatToParts(ms)) part[p.type] = p.value;
  return {
    day: WEEKDAY[part.weekday!]!,
    minute:
      Number(part.hour) * 60 +
      Number(part.minute) +
      (Number(part.second) + (((ms % 1000) + 1000) % 1000) / 1000) / 60,
  };
}

/**
 * The instant `target` local minutes into the day, reached from `t` (at local `minute`) by adding
 * the difference. A DST change in between moves the landing by an hour: an early landing is fixed
 * by the caller's next read, a late one (a skipped hour) here, unless `target` is itself skipped.
 */
function advanceTo(
  t: number,
  minute: number,
  target: number,
  timeZone: string,
): number {
  const next = t + (target - minute) * 60_000;
  const want = target % 1440;
  let late = localTime(next, timeZone).minute - want;
  if (late > 720) late -= 1440;
  if (late < -720) late += 1440;
  if (late <= 1e-6) return next;
  const back = next - late * 60_000;
  return Math.abs(localTime(back, timeZone).minute - want) < 1e-6 ? back : next;
}

/**
 * `start` plus `minutes` counted only inside the business window. Each step re-reads the local
 * time after a jump, so a DST change (a 23- or 25-hour day) corrects itself.
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
  let left = minutes;
  for (let step = 0; step < maxSteps; step++) {
    const { day, minute } = localTime(t, zone);
    if (days.has(day) && minute >= open && minute < close) {
      const room = close - minute;
      if (left <= room) return new Date(Math.round(t + left * 60_000));
      left -= room;
      t += room * 60_000;
    } else if (days.has(day) && minute < open) {
      t = advanceTo(t, minute, open, zone);
    } else {
      t = advanceTo(t, minute, 1440, zone);
    }
  }
  throw new Error(
    `addBusinessMinutes: no result within ${maxSteps} steps (${minutes} minutes in ${zone})`,
  );
}

/** The target for a priority; null or unknown priorities get `normal`, intake's own default. */
export function slaTarget(sla: Sla, priority: string | null | undefined) {
  return priority && priority in sla.targets
    ? sla.targets[priority as SlaPriority]
    : sla.targets.normal;
}

/** When the `kind` clock that started at `start` breaches, for an issue of `priority`. */
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

/** Which clock runs for an issue and when it breaches, or null when none runs. */
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

/** The issue's running SLA clock, or null when `sla` is unset or no clock runs. */
export async function issueSla(db: Db, issue: Issue): Promise<SlaDue | null> {
  const sla = await getConfigOr(db, "sla", null);
  if (!sla) return null;
  return slaDue(
    { ...issue, messages: await messagesForIssue(db, issue.id) },
    sla,
  );
}
