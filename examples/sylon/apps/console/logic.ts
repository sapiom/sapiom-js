/**
 * The pure half of the Sylon Console: what "on" means for an agent, which triggers a switch
 * creates, resumes or deletes, the latency arithmetic of the timeline, which receipts count as
 * failed, and the secret check on mutating routes. No I/O, so all of it is unit-tested.
 */
import { timingSafeEqual } from "node:crypto";

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
  for (const w of wantedTriggers(key)) {
    const hits = attached.filter((a) => sameTrigger(w, a));
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

// --- route guard -----------------------------------------------------------------------------

export const SECRET_HEADER = "x-console-secret";

export type GuardVerdict = "ok" | "unset" | "denied";

/**
 * Mutating routes need the shared secret. The preview URL an App Link redirects to carries a
 * one-hour bearer token and no viewer identity, so anyone holding that URL could otherwise
 * change triggers with the org key this server holds. Fails closed when no secret is configured.
 */
export function checkSecret(
  expected: string | undefined,
  given: string | string[] | undefined,
): GuardVerdict {
  if (!expected) return "unset";
  if (typeof given !== "string") return "denied";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "denied";
}

/** Replace every occurrence of a secret in `text`, so an error message can never echo one. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}
