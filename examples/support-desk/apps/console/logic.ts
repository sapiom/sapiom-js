/**
 * The pure half of the Console: what "on" means for an agent, which triggers a switch
 * creates, resumes or deletes, the latency and cost arithmetic of the metrics, which receipts count
 * as failed, and the scoping that keeps every mutating route on the fleet's own definitions (the
 * server holds an org key). No I/O, so all of it is unit-tested.
 */
import fleet from "../../fleet.json";
import { agentSlug } from "../../_shared/fleet-id";
import type { Direction, IssueStatus } from "../../_shared/issues";
import { KB_KINDS, UUID, type KbInput } from "../../_shared/kb";
import { slaDue, type Sla, type SlaDue, type SlaKind } from "../../_shared/sla";

export interface FleetProject {
  key: string;
  path: string;
  slug: string;
  optional?: boolean;
  smoke?: boolean;
  manual?: boolean;
}

export type FleetTrigger =
  | { project: string; kind: "event"; eventType: string }
  | {
      project: string;
      kind: "schedule_cron";
      cron: string;
      /** IANA zone the cron runs in; unset means UTC, as on the server. */
      timezone?: string;
    };

/** A trigger as `GET /v1/workflows/definitions/<slug>/triggers` lists it. */
export interface AttachedTrigger {
  id: string;
  kind: string;
  status: string;
  eventType: string | null;
  cron: string | null;
  timezone?: string | null;
  definitionSlug?: string;
}

/** The agents the Console operates: every fleet.json project except the smoke pair and the run-by-hand setup agent. */
export const AGENTS: FleetProject[] = (
  fleet.projects as Omit<FleetProject, "slug">[]
)
  .map((p) => ({ ...p, slug: agentSlug(p.key) }))
  .filter((p) => !p.smoke && !p.manual);
/** `triggers` only. `smokeTriggers` are never attached from the Console. */
export const TRIGGERS = fleet.triggers as FleetTrigger[];

/** The live-added agent, which the fleet-wide Pause and Resume leave alone. */
export const LIVE_AGENT = "urgent-pager";
export const CONTROLLER = "controller";

export function agentByKey(key: string): FleetProject | undefined {
  return AGENTS.find((a) => a.key === key);
}

export function wantedTriggers(key: string): FleetTrigger[] {
  return TRIGGERS.filter((t) => t.project === key);
}

/** A disabled trigger is a deleted one; active and paused ones are attached. */
export function sameTrigger(
  want: FleetTrigger,
  have: AttachedTrigger,
): boolean {
  if (have.status === "disabled" || have.kind !== want.kind) return false;
  return want.kind === "event"
    ? have.eventType === want.eventType
    : have.cron === want.cron &&
        (have.timezone ?? "UTC") === (want.timezone ?? "UTC");
}

export function triggerLabel(t: FleetTrigger): string {
  return t.kind === "event"
    ? t.eventType
    : `cron ${t.cron}${t.timezone ? ` ${t.timezone}` : ""}`;
}

export function triggerBody(t: FleetTrigger): Record<string, string> {
  return t.kind === "event"
    ? { kind: t.kind, eventType: t.eventType }
    : t.timezone
      ? { kind: t.kind, cron: t.cron, timezone: t.timezone }
      : { kind: t.kind, cron: t.cron };
}

export interface TriggerState {
  label: string;
  /** `active`, `paused` (the engine paused it after failures), or `missing`. */
  state: "active" | "paused" | "missing";
  id: string | null;
}

/** Each trigger fleet.json lists for `key`, matched against what is attached. */
export function triggerStates(
  key: string,
  attached: AttachedTrigger[],
): TriggerState[] {
  return wantedTriggers(key).map((w) => {
    const hit = attached.find((a) => sameTrigger(w, a));
    return {
      label: triggerLabel(w),
      state: !hit ? "missing" : hit.status === "active" ? "active" : "paused",
      id: hit?.id ?? null,
    };
  });
}

/** "On" means every trigger fleet.json lists for the agent is attached and active. */
export function isOn(key: string, attached: AttachedTrigger[]): boolean {
  const states = triggerStates(key, attached);
  return states.length > 0 && states.every((s) => s.state === "active");
}

export interface SwitchPlan {
  create: FleetTrigger[];
  resume: string[];
  remove: string[];
}

/**
 * What turning an agent on or off does. On: create the missing triggers and resume paused ones
 * (listing first matters for cron, which the server would happily attach twice). Off: delete
 * every attached trigger fleet.json lists for the agent, and nothing else it may have.
 */
export function planSwitch(
  key: string,
  on: boolean,
  attached: AttachedTrigger[],
): SwitchPlan {
  const plan: SwitchPlan = { create: [], resume: [], remove: [] };
  const slug = agentByKey(key)?.slug;
  if (!slug) return plan;
  // Only the agent's own triggers, even if a listing ever returned another definition's.
  const own = attached.filter(
    (a) => a.definitionSlug === undefined || a.definitionSlug === slug,
  );
  for (const w of wantedTriggers(key)) {
    const hits = own.filter((a) => sameTrigger(w, a));
    if (on) {
      const active = hits.find((h) => h.status === "active");
      if (active) continue;
      if (hits[0]) plan.resume.push(hits[0].id);
      else plan.create.push(w);
    } else {
      plan.remove.push(...hits.map((h) => h.id));
    }
  }
  return plan;
}

/** The agents a fleet-wide Pause or Resume acts on. */
export function fleetWideKeys(): string[] {
  return AGENTS.filter((a) => a.key !== LIVE_AGENT).map((a) => a.key);
}

// --- desks -----------------------------------------------------------------------------------

export type DeskPick<D> =
  | { ok: true; desk: D }
  | { ok: false; status: 404 | 409; reason: string };

/**
 * The desk a request is about: the one named by `?desk=<slug>`, else the default desk. A page
 * never silently shows another desk than the one it asked for, so an unknown slug is a 404.
 */
export function pickDesk<D extends { slug: string; isDefault: boolean }>(
  desks: readonly D[],
  slug: string | null,
): DeskPick<D> {
  if (!desks.length)
    return {
      ok: false,
      status: 409,
      reason: "no desks yet; run `pnpm run setup`",
    };
  if (slug) {
    const named = desks.find((d) => d.slug === slug);
    return named
      ? { ok: true, desk: named }
      : { ok: false, status: 404, reason: `no desk '${slug}'` };
  }
  return { ok: true, desk: desks.find((d) => d.isDefault) ?? desks[0]! };
}

/**
 * Failed receipts for one desk. A receipt that carries an issue (a domain event) belongs to that
 * issue's desk. One that does not (a raw Slack event, which fires before any issue exists) cannot
 * be attributed, so it shows on every desk rather than being hidden from the one it broke.
 */
export function scopeReceipts<T extends { id: string }>(
  receipts: readonly T[],
  deskOf: ReadonlyMap<string, string | null>,
  deskId: string,
): T[] {
  return receipts.filter((r) => {
    const owner = deskOf.get(r.id);
    return owner === undefined || owner === null || owner === deskId;
  });
}

// --- system map ----------------------------------------------------------------------------

export interface AgentRole {
  emits: string[];
  /** Tables it writes, then what it posts outside the database. */
  writes: string;
}

/** What each agent emits and writes, as its code does; fleet.json says only what it listens to. */
export const AGENT_ROLES: Record<string, AgentRole> = {
  intake: {
    emits: ["issue.created", "issue.message_added"],
    writes:
      "messages, issues, accounts, runs, events_log; posts the ticket card and mirrors customer messages in triage, reacts in the customer channel",
  },
  copilot: {
    emits: ["issue.escalate"],
    writes:
      "drafts, messages, issues (status, summary), doc_cache, runs, events_log; reads kb_articles and the configured docs site (knowledge.docs_url); posts draft cards in triage and the approved reply in the customer thread",
  },
  escalation: {
    emits: ["issue.on_hold"],
    writes:
      "issues (Linear link, on_hold), messages, runs, events_log; creates the Linear issue, replies in both threads",
  },
  controller: {
    emits: ["issue.nudged"],
    writes:
      "nudges, runs, events_log; posts nudges in triage threads, DMs on-call and mentions the support group when an issue escalates",
  },
  "linear-sync": {
    emits: ["issue.engineering_resolved"],
    writes:
      "issues (status, linear_checked_at, card_dirty), messages, runs, events_log; reads Linear; posts in triage threads",
  },
  "urgent-pager": {
    emits: [],
    writes: "messages, runs; DMs on-call for urgent issues",
  },
  watchdog: {
    emits: [],
    writes:
      "watchdog_alerts; posts each failed support desk run, from sapiom.run.failed, with action items",
  },
  digest: {
    emits: [],
    writes:
      "digests, runs; posts the daily digest in each desk's triage channel",
  },
};

/** What the agent listens to, from fleet.json `triggers`. */
export function listensTo(key: string): string[] {
  return wantedTriggers(key).map(triggerLabel);
}

/** The fleet database's tables, one line each. */
export const TABLES: [string, string][] = [
  [
    "desks",
    "isolated support desks: triage channel, Linear team and project, on-call, nudge minutes",
  ],
  ["accounts", "one row per customer channel (name, Slack channel id, desk)"],
  [
    "issues",
    "the tickets: desk, status, category, priority, owner, both Slack threads, Linear link",
  ],
  [
    "messages",
    "every customer, agent and internal message, keyed by Slack event id",
  ],
  ["drafts", "AI reply drafts and their Approve / Escalate / Dismiss outcome"],
  [
    "nudges",
    "follow-ups and escalations the controller already sent, one per issue, condition and round, or level",
  ],
  ["digests", "daily digests already posted, one per desk and day"],
  ["runs", "each agent execution and the issue it worked on"],
  [
    "kb_articles",
    "the team's policies and answers the copilot drafts from (one desk's or all desks'), edited in the Knowledge tab",
  ],
  [
    "doc_cache",
    "docs pages the copilot fetched from knowledge.docs_url, kept for an hour",
  ],
  [
    "events_log",
    "every domain event an agent emitted, with its engine receipt id",
  ],
  [
    "config",
    "runtime config: customer channels, alerts channel, switches, escalation per desk, SLA targets (other desk settings live in desks)",
  ],
  ["schema_migrations", "applied migrations"],
];

export const slackChannelUrl = (teamId: string, channelId: string) =>
  `https://app.slack.com/client/${teamId}/${channelId}`;

/** An issue's Linear URL, from the project URL's workspace (`https://linear.app/<ws>/project/...`). */
export function linearIssueUrl(
  projectUrl: string | null,
  identifier: string | null,
): string | null {
  if (!projectUrl || !identifier) return null;
  const m = /^https:\/\/linear\.app\/([^/]+)\//.exec(projectUrl);
  return m ? `https://linear.app/${m[1]}/issue/${identifier}` : null;
}

export const agentPageUrl = (definitionId: string) =>
  `https://app.sapiom.ai/agents/${definitionId}`;

// Clamp sub-minute spans to avoid displaying a zero-minute deadline.
function span(ms: number, round: (x: number) => number): string {
  const m = Math.max(1, round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function slaLabel(
  due: Pick<SlaDue, "kind" | "dueAt"> | null,
  now: Date,
): string | null {
  if (!due) return null;
  const what =
    due.kind === "first_response" ? "first response" : "next response";
  const left = due.dueAt.getTime() - now.getTime();
  return left > 0
    ? `${what} in ${span(left, Math.ceil)}`
    : `${what} breached ${span(-left, Math.floor)} ago`;
}

export interface BoardSla {
  slaKind: SlaKind | null;
  slaDueAt: string | null;
  slaLabel: string | null;
}

/** Each board row's running SLA clock, in row order; all null when `sla` is unset. */
export function boardSla(
  rows: readonly {
    id: string;
    status: string;
    priority: string | null;
    createdAt: Date | string;
  }[],
  messages: readonly {
    issue_id: string;
    direction: string;
    ts: string | null;
    created_at: Date | string;
  }[],
  sla: Sla | null,
  now: Date,
): BoardSla[] {
  const byIssue = new Map<string, (typeof messages)[number][]>();
  for (const m of messages) {
    const list = byIssue.get(m.issue_id);
    if (list) list.push(m);
    else byIssue.set(m.issue_id, [m]);
  }
  return rows.map((r) => {
    const due = sla
      ? slaDue(
          {
            status: r.status as IssueStatus,
            priority: r.priority,
            createdAt: new Date(r.createdAt),
            messages: (byIssue.get(r.id) ?? []).map((m) => ({
              direction: m.direction as Direction,
              ts: m.ts,
              createdAt: new Date(m.created_at),
            })),
          },
          sla,
        )
      : null;
    return {
      slaKind: due?.kind ?? null,
      slaDueAt: due?.dueAt.toISOString() ?? null,
      slaLabel: slaLabel(due, now),
    };
  });
}

// --- latency ---------------------------------------------------------------------------------

/** A Slack `ts` (`"1790889355.981329"`, seconds since the epoch) in milliseconds. */
export function slackTsToMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Number(ts);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

export function toMs(t: Date | string | null | undefined): number | null {
  if (t == null) return null;
  const n = (t instanceof Date ? t : new Date(t)).getTime();
  return Number.isFinite(n) ? n : null;
}

/** Seconds from `from` to `to`, one decimal, or null when either end is missing. */
export function secondsBetween(
  from: number | null,
  to: number | null,
): number | null {
  if (from == null || to == null) return null;
  return Math.round((to - from) / 100) / 10;
}

export interface TimelineInput {
  customerTs: string | null;
  triageRootTs: string | null;
  issueCreatedAt: Date | string;
  draftCreatedAt: Date | string | null;
  draftCardTs: string | null;
}

export interface Latencies {
  /** Customer message → issue card in triage. */
  messageToCard: number | null;
  /** Issue row created → first draft row created. */
  issueToDraft: number | null;
  /** Issue row created → first draft card posted. */
  issueToDraftCard: number | null;
  /** Customer message → first draft card posted: what the customer's teammate waits. */
  messageToDraftCard: number | null;
}

export function latencies(t: TimelineInput): Latencies {
  const customer = slackTsToMs(t.customerTs);
  const issue = toMs(t.issueCreatedAt);
  const card = slackTsToMs(t.draftCardTs);
  // A leg that ends before it starts is not a latency: a seeded test message can carry a later ts
  // than the card it opened. Leaving it in would drag the percentiles below zero.
  const leg = (from: number | null, to: number | null) => {
    const s = secondsBetween(from, to);
    return s !== null && s < 0 ? null : s;
  };
  return {
    messageToCard: leg(customer, slackTsToMs(t.triageRootTs)),
    issueToDraft: leg(issue, toMs(t.draftCreatedAt)),
    issueToDraftCard: leg(issue, card),
    messageToDraftCard: leg(customer, card),
  };
}

/**
 * Draft creation time from the first draft row, card time from the first row whose card posted:
 * a draft row exists before its Slack post, so an earlier failed post must not hide a later card.
 */
export function draftTimes(
  drafts: { card_ts?: unknown; created_at?: unknown }[],
): { draftCreatedAt: Date | null; draftCardTs: string | null } {
  const posted = drafts.find((d) => d.card_ts != null);
  return {
    draftCreatedAt: (drafts[0]?.created_at as Date | undefined) ?? null,
    draftCardTs: (posted?.card_ts as string | undefined) ?? null,
  };
}

// --- receipts --------------------------------------------------------------------------------

export interface ReceiptSummary {
  id: string;
  eventType: string;
  externalEventId: string;
  outcome: string;
  receivedAt: string;
  deliveries: { total: number; failed: number; stale?: number };
  triggerSlugs: string[];
  failedTriggerSlugs: string[];
}

/** Rows per receipts request (the API's maximum). */
export const RECEIPT_PAGE = 200;
/** Pages read per list, so one page load costs a bounded number of API calls. */
export const RECEIPT_MAX_PAGES = 10;

/**
 * Receipts newest first, paged by offset until a short page, a receipt older than `since`, or
 * `maxPages`. `truncated` is true when more rows may exist beyond what was read.
 */
export async function pageReceipts(
  fetchPage: (offset: number, limit: number) => Promise<ReceiptSummary[]>,
  opts: { since?: number; maxPages?: number; pageSize?: number } = {},
): Promise<{ receipts: ReceiptSummary[]; truncated: boolean }> {
  const pageSize = opts.pageSize ?? RECEIPT_PAGE;
  const maxPages = opts.maxPages ?? RECEIPT_MAX_PAGES;
  const receipts: ReceiptSummary[] = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(page * pageSize, pageSize);
    receipts.push(...rows);
    if (rows.length < pageSize) return { receipts, truncated: false };
    const oldest = toMs(rows[rows.length - 1]!.receivedAt);
    if (opts.since != null && oldest != null && oldest < opts.since)
      return { receipts, truncated: false };
  }
  return { receipts, truncated: true };
}

/** Receipts with a failed delivery to a fleet agent; other workflows' failures are not ours to replay. */
export function failedFleetReceipts(
  receipts: ReceiptSummary[],
  slugs: string[] = AGENTS.map((a) => a.slug),
): ReceiptSummary[] {
  const ours = new Set(slugs);
  return receipts.filter(
    (r) =>
      r.deliveries.failed > 0 && r.failedTriggerSlugs.some((s) => ours.has(s)),
  );
}

/** What the page shows of a receipt: no sender ip, user agent or payload detail. */
export function receiptView(r: ReceiptSummary) {
  return {
    id: r.id,
    eventType: r.eventType,
    receivedAt: r.receivedAt,
    failed: r.deliveries.failed,
    failedTriggerSlugs: r.failedTriggerSlugs,
  };
}

// --- replay scoping --------------------------------------------------------------------------

/** One fire of `GET /v1/workflows/receipts/<id>`. */
export interface ReceiptFire {
  id: string;
  state: string;
  stale?: boolean;
  trigger: { definitionSlug: string } | null;
}

export type ReplayPlan =
  | { ok: true; fireIds: string[] }
  | { ok: false; status: 403 | 409; reason: string };

/**
 * Which fires of a receipt the Console may re-drive. A receipt replay would re-fire every failed
 * fire, and Slack events fan out to other workflows too (`backlog-nudge` shares
 * `slack.block_actions`), so the Console replays fire by fire, only fires on a fleet slug. A
 * receipt with no fleet fire is refused outright.
 */
export function replayPlan(
  fires: ReceiptFire[],
  slugs: string[] = AGENTS.map((a) => a.slug),
): ReplayPlan {
  const ours = new Set(slugs);
  const fleet = fires.filter(
    (f) => f.trigger && ours.has(f.trigger.definitionSlug),
  );
  if (!fleet.length)
    return { ok: false, status: 403, reason: "not a fleet receipt" };
  const failed = fleet.filter(
    (f) => f.state === "failed" || (f.state === "claimed" && f.stale),
  );
  if (!failed.length)
    return {
      ok: false,
      status: 409,
      reason: "no failed fleet delivery to replay",
    };
  return { ok: true, fireIds: failed.map((f) => f.id) };
}

/** Replace every occurrence of a secret in `text`, so an error message can never echo one. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

// --- cues ------------------------------------------------------------------------------------

export interface ReplayScript {
  prefix: string;
  steps: { id: string; text: string; expect: string; threadOf?: string }[];
}

/** The customer lines for the Cues tab, from `scripts/replay.json`, the one script of them. */
export function cuesFromReplay(replay: ReplayScript) {
  const words = (id: string) => {
    const w = id.replace(/-/g, " ");
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  return {
    prefix: replay.prefix,
    steps: replay.steps.map((s) => ({
      id: s.id,
      label: s.threadOf
        ? `${words(s.id)} (reply in the ${s.threadOf} thread)`
        : words(s.id),
      text: s.text,
      expect: s.expect,
    })),
  };
}

// --- metrics ---------------------------------------------------------------------------------

export const METRIC_WINDOWS = { "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000 };
export type MetricWindow = keyof typeof METRIC_WINDOWS;

export function parseWindow(raw: string | null): MetricWindow | null {
  if (raw === null) return "24h";
  return raw in METRIC_WINDOWS ? (raw as MetricWindow) : null;
}

/** What the Console compares its cost per ticket against (a hosted support desk's per-ticket price). */
export const TARGET_USD_PER_TICKET = 3;

/** Nearest-rank percentile (`p` in 0..100) of the finite numbers in `values`; null when none. */
export function percentile(
  values: (number | null | undefined)[],
  p: number,
): number | null {
  const v = values
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)]!;
}

export interface Spread {
  n: number;
  p50: number | null;
  p90: number | null;
}

export function spread(values: (number | null | undefined)[]): Spread {
  return {
    n: values.filter((x) => typeof x === "number" && Number.isFinite(x)).length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
  };
}

/** p50 and p90 across issues of each latency leg. */
export function summarizeLatencies(all: Latencies[]) {
  return {
    messageToCard: spread(all.map((l) => l.messageToCard)),
    issueToDraftCard: spread(all.map((l) => l.issueToDraftCard)),
    messageToDraftCard: spread(all.map((l) => l.messageToDraftCard)),
  };
}

/** Tickets opened in each 24-hour bucket back from `now`, oldest first; the last covers the past day. */
export function ticketsPerDay(
  createdAt: (Date | string)[],
  now: number,
  days: number,
): number[] {
  const DAY = 24 * 3600_000;
  const out = new Array<number>(days).fill(0);
  for (const t of createdAt) {
    const ms = toMs(t);
    if (ms == null) continue;
    const back = Math.floor((now - ms) / DAY);
    if (back >= 0 && back < days) out[days - 1 - back]! += 1;
  }
  return out;
}

/** `GET /v1/workflows/executions/<id>/spend`. */
export interface ExecutionSpend {
  totalUsd: number | string;
  settleState?: string;
  llm?: { listUsd?: number | string | null } | null;
  capability?: { totalUsd?: number | string | null } | null;
  compute?: { sandboxSeconds?: number | string | null } | null;
}

export interface Cost {
  usd: number;
  llmUsd: number;
  capabilityUsd: number;
  sandboxSeconds: number;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function costOf(s: ExecutionSpend): Cost {
  return {
    usd: num(s.totalUsd),
    llmUsd: num(s.llm?.listUsd),
    capabilityUsd: num(s.capability?.totalUsd),
    sandboxSeconds: num(s.compute?.sandboxSeconds),
  };
}

export const isFinalSpend = (s: ExecutionSpend) => s.settleState === "final";

export function sumCosts(costs: Cost[]): Cost {
  const t: Cost = { usd: 0, llmUsd: 0, capabilityUsd: 0, sandboxSeconds: 0 };
  for (const c of costs) {
    t.usd += c.usd;
    t.llmUsd += c.llmUsd;
    t.capabilityUsd += c.capabilityUsd;
    t.sandboxSeconds += c.sandboxSeconds;
  }
  return t;
}

export interface IssueCost extends Cost {
  /** Runs of the issue whose spend was read / not read (over the per-request call bound). */
  runsCounted: number;
  runsMissing: number;
}

/** Tickets with at least one counted run are priced; the rest are left out of the mean and p90. */
export function costSummary(issues: IssueCost[]) {
  const priced = issues.filter((i) => i.runsCounted > 0);
  const total = sumCosts(priced);
  const mean = (v: number) => (priced.length ? v / priced.length : null);
  return {
    tickets: priced.length,
    unpriced: issues.length - priced.length,
    meanUsd: mean(total.usd),
    p90Usd: percentile(
      priced.map((i) => i.usd),
      90,
    ),
    totalUsd: total.usd,
    llmUsd: total.llmUsd,
    capabilityUsd: total.capabilityUsd,
    meanSandboxSeconds: mean(total.sandboxSeconds),
    targetUsdPerTicket: TARGET_USD_PER_TICKET,
  };
}

// --- knowledge base --------------------------------------------------------------------------

export const KB_TITLE_MAX = 200;
export const KB_BODY_MAX = 8000;

export type KbParse =
  | { ok: true; value: Partial<KbInput> }
  | { ok: false; error: string };

/**
 * Validate a Knowledge tab request body. Create needs kind, title and body; update takes any
 * subset but at least one field. Strings are trimmed and may not be empty. Other keys are ignored,
 * so a request can never set `updated_by` or an id.
 */
export function parseKbInput(raw: unknown, mode: "create" | "update"): KbParse {
  // A JSON body can be null, an array or a scalar; only an object has fields to read.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "body must be a JSON object" };
  const body = raw as Record<string, unknown>;
  const value: Partial<KbInput> = {};
  if (body.kind !== undefined) {
    if (!(KB_KINDS as readonly unknown[]).includes(body.kind))
      return { ok: false, error: `kind must be ${KB_KINDS.join(" or ")}` };
    value.kind = body.kind as KbInput["kind"];
  }
  for (const [key, max] of [
    ["title", KB_TITLE_MAX],
    ["body", KB_BODY_MAX],
  ] as const) {
    const raw = body[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !raw.trim())
      return { ok: false, error: `${key} must be non-empty text` };
    if (raw.trim().length > max)
      return { ok: false, error: `${key} is over ${max} characters` };
    value[key] = raw.trim();
  }
  // `deskId`: a desk's id, or null for an article that applies to every desk.
  if (body.deskId !== undefined) {
    if (
      body.deskId !== null &&
      !(typeof body.deskId === "string" && UUID.test(body.deskId))
    )
      return { ok: false, error: "deskId must be a desk id or null" };
    value.deskId = body.deskId;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean")
      return { ok: false, error: "enabled must be true or false" };
    value.enabled = body.enabled;
  }
  if (mode === "create") {
    for (const key of ["kind", "title", "body"] as const)
      if (value[key] === undefined)
        return { ok: false, error: `${key} is required` };
  } else if (Object.keys(value).length === 0) {
    return { ok: false, error: "nothing to update" };
  }
  return { ok: true, value };
}
