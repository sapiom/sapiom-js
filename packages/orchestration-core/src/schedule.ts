/**
 * schedule — manage scheduled triggers for a server-side orchestration definition.
 *
 * Networked operations: each takes a GatewayClient. The backend routes sit under the
 * `/v1/workflows` base the client already targets: create/list nest under the definition slug
 * (`/:slug/triggers`); detail/cancel are top-level (`/triggers/:id`); cron preview is stateless
 * (`/triggers/preview-cron`). "Schedule" is the SDK word for the engine's "trigger".
 */
import { GatewayClient } from './client.js';

export type ScheduleKind = 'schedule_cron' | 'schedule_once';
export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'disabled';

export interface SchedulePolicy {
  catchupPolicy?: 'skip' | 'all';
  overlapPolicy?: 'allow' | 'skip';
  jitterMs?: number;
}

export interface CreateScheduleOptions {
  /** Tenant-unique slug of the orchestration to schedule. */
  definition: string;
  kind: ScheduleKind;
  /** Execution input passed to each fire. */
  input?: unknown;
  /** Recurring (`schedule_cron`): the cron expression (required for that kind). */
  cron?: string;
  /** IANA timezone the cron is evaluated in (defaults to UTC server-side). */
  timezone?: string;
  startAt?: string;
  endAt?: string;
  policy?: SchedulePolicy;
  /** One-off (`schedule_once`): the single fire time (ISO 8601; required for that kind). */
  at?: string;
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
  /** Recent fire ledger (newest first) — the debug view. */
  recentFires: ScheduleFireRecord[];
}

export interface ListSchedulesOptions {
  definition: string;
  status?: ScheduleStatus;
  limit?: number;
  offset?: number;
}

export interface CronPreviewOptions {
  cron: string;
  timezone?: string;
  count?: number;
}

export interface CronPreview {
  cron: string;
  timezone: string;
  occurrences: string[];
}

/** Create a schedule (cron or one-off) for the orchestration. Returns the schedule detail. */
export async function createSchedule(opts: CreateScheduleOptions, client: GatewayClient): Promise<ScheduleDetail> {
  const { definition, ...body } = opts;
  return client.post<ScheduleDetail>(`/${encodeURIComponent(definition)}/triggers`, body);
}

/** List an orchestration's schedules (newest first), optionally filtered by status. */
export async function listSchedules(opts: ListSchedulesOptions, client: GatewayClient): Promise<ScheduleSummary[]> {
  const { definition, ...filters } = opts;
  return client.get<ScheduleSummary[]>(`/${encodeURIComponent(definition)}/triggers${toQuery(filters)}`);
}

/** Get one schedule: config + next fire + recent fire ledger. */
export async function getSchedule(id: string, client: GatewayClient): Promise<ScheduleDetail> {
  return client.get<ScheduleDetail>(`/triggers/${encodeURIComponent(id)}`);
}

/** Cancel a schedule. */
export async function cancelSchedule(
  id: string,
  client: GatewayClient,
): Promise<{ id: string; status: ScheduleStatus }> {
  return client.request<{ id: string; status: ScheduleStatus }>('DELETE', `/triggers/${encodeURIComponent(id)}`);
}

/** Validate a cron expression + timezone and preview the next occurrences (no persistence). */
export async function previewCron(opts: CronPreviewOptions, client: GatewayClient): Promise<CronPreview> {
  return client.post<CronPreview>('/triggers/preview-cron', opts);
}

function toQuery(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
