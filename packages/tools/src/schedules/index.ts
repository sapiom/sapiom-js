/**
 * `schedules` capability — create and manage schedules (cron + one-off triggers) for a deployed
 * orchestration, addressed by its slug.
 *
 *   import { schedules } from "@sapiom/tools";
 *   await schedules.create({ definition: "enrich-lead", kind: "schedule_cron", cron: "0 9 * * 1-5" });
 *
 * "Schedule" is the SDK word for the engine's "trigger". Routes sit under the agents gateway
 * (`/agents/v1`, same front door as {@link ../agents/index.js}): create/list nest under
 * `definitions/:slug/triggers` (slug never a leading segment); detail/cancel are top-level under
 * `/agents/v1/triggers`.
 */
import { Transport, defaultTransport } from "../_client/index.js";

const DEFAULT_BASE_URL =
  process.env.SAPIOM_AGENTS_URL ??
  process.env.SAPIOM_TOOLS_BASE ??
  "https://tools.sapiom.ai";

export type ScheduleKind = "schedule_cron" | "schedule_once";
export type ScheduleStatus = "active" | "paused" | "completed" | "disabled";

export interface SchedulePolicy {
  catchupPolicy?: "skip" | "all";
  overlapPolicy?: "allow" | "skip";
  jitterMs?: number;
}

export interface CreateScheduleSpec {
  /** The orchestration's tenant-unique slug. */
  definition: string;
  kind: ScheduleKind;
  input?: unknown;
  /** Recurring (`schedule_cron`): cron expression + optional timezone/bounds/policy. */
  cron?: string;
  timezone?: string;
  startAt?: string;
  endAt?: string;
  policy?: SchedulePolicy;
  /** One-off (`schedule_once`): the single fire time. Accepts a `Date` or an ISO 8601 string. */
  at?: string | Date;
}

export interface ScheduleFireRecord {
  scheduledFor: string;
  state: string;
  firedAt: string | null;
  executionId: string | null;
  error?: unknown;
}

export interface ScheduleSummary {
  id: string;
  kind: ScheduleKind;
  status: ScheduleStatus;
  definitionSlug: string;
  cron: string | null;
  timezone: string | null;
  nextFireAt: string | null;
  createdAt: string;
}

export interface ScheduleDetail extends ScheduleSummary {
  input: unknown;
  startAt: string | null;
  endAt: string | null;
  policy: unknown;
  recentFires: ScheduleFireRecord[];
}

export interface ListSchedulesOptions {
  status?: ScheduleStatus;
  limit?: number;
  offset?: number;
}

/** Create a schedule (cron or one-off) for the orchestration. */
export async function create(
  spec: CreateScheduleSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ScheduleDetail> {
  const { definition, ...body } = spec;
  return transport.request<ScheduleDetail>(
    `${baseUrl}/agents/v1/definitions/${encodeURIComponent(definition)}/triggers`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** List an orchestration's schedules. */
export async function list(
  definition: string,
  opts: ListSchedulesOptions = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ScheduleSummary[]> {
  return transport.request<ScheduleSummary[]>(
    `${baseUrl}/agents/v1/definitions/${encodeURIComponent(definition)}/triggers${toQuery(opts)}`,
  );
}

/** Get one schedule: config + next fire + recent fire ledger. */
export async function get(
  scheduleId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ScheduleDetail> {
  return transport.request<ScheduleDetail>(
    `${baseUrl}/agents/v1/triggers/${encodeURIComponent(scheduleId)}`,
  );
}

/** Cancel a schedule. */
export async function cancel(
  scheduleId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<{ id: string; status: ScheduleStatus }> {
  return transport.request<{ id: string; status: ScheduleStatus }>(
    `${baseUrl}/agents/v1/triggers/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" },
  );
}

function toQuery(opts: ListSchedulesOptions): string {
  const params = new URLSearchParams();
  if (opts.status !== undefined) params.set("status", opts.status);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
