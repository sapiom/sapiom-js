/**
 * The pure half of the Sylon Console: what "on" means for an agent, which triggers a switch
 * creates, resumes or deletes, the latency arithmetic of the timeline, which receipts count as
 * failed, and the scoping that keeps every mutating route on the fleet's own definitions (the
 * server holds an org key). No I/O, so all of it is unit-tested.
 */
import fleet from "../../fleet.json";

export interface FleetProject {
  key: string;
  path: string;
  slug: string;
  optional?: boolean;
  smoke?: boolean;
}

export type FleetTrigger =
  | { project: string; kind: "event"; eventType: string }
  | { project: string; kind: "schedule_cron"; cron: string };

/** A trigger as `GET /v1/workflows/definitions/<slug>/triggers` lists it. */
export interface AttachedTrigger {
  id: string;
  kind: string;
  status: string;
  eventType: string | null;
  cron: string | null;
  definitionSlug?: string;
}

/** The agents the Console operates: every fleet.json project except the smoke pair. */
export const AGENTS = (fleet.projects as FleetProject[]).filter(
  (p) => !p.smoke,
);
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
    : have.cron === want.cron;
}

export function triggerLabel(t: FleetTrigger): string {
  return t.kind === "event" ? t.eventType : `cron ${t.cron}`;
}

export function triggerBody(t: FleetTrigger): Record<string, string> {
  return t.kind === "event"
    ? { kind: t.kind, eventType: t.eventType }
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
      "drafts, messages, issues (status, summary), runs, events_log; posts draft cards in triage and the approved reply in the customer thread",
  },
  escalation: {
    emits: ["issue.on_hold"],
    writes:
      "issues (Linear link, on_hold), messages, runs, events_log; creates the Linear issue, replies in both threads",
  },
  controller: {
    emits: ["issue.nudged"],
    writes: "nudges, runs, events_log; posts nudges in triage threads",
  },
  "urgent-pager": {
    emits: [],
    writes: "messages, runs; DMs on-call for urgent issues",
  },
};

/** What the agent listens to, from fleet.json `triggers`. */
export function listensTo(key: string): string[] {
  return wantedTriggers(key).map(triggerLabel);
}

/** The `sylon` database's tables, one line each. */
export const TABLES: [string, string][] = [
  ["accounts", "one row per customer channel (name, Slack channel id)"],
  [
    "issues",
    "the tickets: status, category, priority, owner, both Slack threads, Linear link",
  ],
  [
    "messages",
    "every customer, agent and internal message, keyed by Slack event id",
  ],
  ["drafts", "AI reply drafts and their Approve / Escalate / Dismiss outcome"],
  [
    "nudges",
    "follow-ups the controller already sent, one per issue and condition",
  ],
  ["runs", "each agent execution and the issue it worked on"],
  [
    "events_log",
    "every domain event an agent emitted, with its engine receipt id",
  ],
  [
    "config",
    "runtime config: channels, on-call, Linear team and project, nudge minutes",
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
  return {
    messageToCard: secondsBetween(customer, slackTsToMs(t.triageRootTs)),
    issueToDraft: secondsBetween(issue, toMs(t.draftCreatedAt)),
    issueToDraftCard: secondsBetween(issue, card),
    messageToDraftCard: secondsBetween(customer, card),
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

/** Receipts with a failed delivery to a Sylon agent; other workflows' failures are not ours to replay. */
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
    return { ok: false, status: 403, reason: "not a Sylon receipt" };
  const failed = fleet.filter(
    (f) => f.state === "failed" || (f.state === "claimed" && f.stale),
  );
  if (!failed.length)
    return {
      ok: false,
      status: 409,
      reason: "no failed Sylon delivery to replay",
    };
  return { ok: true, fireIds: failed.map((f) => f.id) };
}

/** Replace every occurrence of a secret in `text`, so an error message can never echo one. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}
