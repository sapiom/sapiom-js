/**
 * schedule — manage scheduled triggers for a server-side agent definition.
 *
 * Networked operations: each takes a GatewayClient. The backend routes sit under the
 * `/v1/workflows` base the client already targets: create/list nest under the definition
 * (`/definitions/:slug/triggers`) so the slug is never a leading path segment; detail/cancel are
 * top-level (`/triggers/:id`); cron preview is stateless (`/triggers/preview-cron`). "Schedule" is
 * the SDK word for the engine's "trigger" — and since the engine accepts four trigger kinds, a
 * "schedule" here may be a cron, a one-off, an event route, or a public webhook. The webhook secret
 * lifecycle (rotate / complete / revoke, SAP-2835) hangs off the same `/triggers/:id` id.
 */
import { GatewayClient } from "./client.js";

/**
 * The four trigger kinds the engine accepts. `schedule_cron` needs `cron`; `schedule_once` needs
 * `at`; `event` needs `eventType` (fires when the tenant emits that type); `webhook` needs nothing —
 * the engine mints its public URL and a shown-once signing secret.
 */
export type ScheduleKind =
  | "schedule_cron"
  | "schedule_once"
  | "event"
  | "webhook";
export type ScheduleStatus = "active" | "paused" | "completed" | "disabled";

export interface SchedulePolicy {
  catchupPolicy?: "skip" | "all";
  overlapPolicy?: "allow" | "skip";
  jitterMs?: number;
}

export interface CreateScheduleOptions {
  /** Tenant-unique slug of the agent to schedule. */
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
  /** One-off (`schedule_once`): the single fire time. Accepts a `Date` or an ISO 8601 string. */
  at?: string | Date;
  /**
   * Event (`event`): the event type this trigger matches (required for that kind). Lowercase
   * dot-separated segments (`lead.created`); the `sapiom.*` namespace is reserved. Emitted via
   * `POST /v1/workflows/events` with `{ type, payload }`.
   */
  eventType?: string;
}

export interface ScheduleFireRecord {
  /** The occurrence time. Null on an event or webhook fire, which has none. */
  scheduledFor: string | null;
  /** The inbound event or webhook receipt this fire answers. Null on a schedule fire. */
  receiptId?: string | null;
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
  /** Event triggers only — the type they match on. Null for the other kinds. */
  eventType: string | null;
  /** Webhook only — the public URL path segment the hook is reachable at. Not a secret. */
  publicId: string | null;
  /** Webhook only — the live secret's version. Not a secret; derives nothing on its own. */
  secretVersion: number | null;
  /** Webhook only — while non-null, the previous secret still verifies (rotation grace, ISO). */
  graceUntil: string | null;
  /** Webhook only — when the hook was revoked (ISO). `status` is `disabled` from then on. */
  revokedAt: string | null;
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

/**
 * The signing material a webhook create or rotate hands back — the ONLY two responses that carry
 * it. The secret is derived, never stored, so it cannot be read back later: lose it and rotate.
 * `url` is the public ingress the sender POSTs to.
 */
export interface WebhookSecretMaterial {
  secret: string;
  url: string;
}

/** `createSchedule` result: a plain detail, plus the secret material when `kind` is `webhook`. */
export type CreateScheduleResult = ScheduleDetail &
  Partial<WebhookSecretMaterial>;

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

/**
 * Create a trigger for the agent — cron, one-off, event, or webhook. Returns the schedule detail;
 * a `webhook` create also carries `secret` + `url` (shown once — see `WebhookSecretMaterial`).
 */
export async function createSchedule(
  opts: CreateScheduleOptions,
  client: GatewayClient,
): Promise<CreateScheduleResult> {
  const { definition, ...body } = opts;
  return client.post<CreateScheduleResult>(
    `/definitions/${encodeURIComponent(definition)}/triggers`,
    body,
  );
}

/** List an agent's schedules (newest first), optionally filtered by status. */
export async function listSchedules(
  opts: ListSchedulesOptions,
  client: GatewayClient,
): Promise<ScheduleSummary[]> {
  const { definition, ...filters } = opts;
  return client.get<ScheduleSummary[]>(
    `/definitions/${encodeURIComponent(definition)}/triggers${toQuery(filters)}`,
  );
}

/** Get one schedule: config + next fire + recent fire ledger. */
export async function getSchedule(
  id: string,
  client: GatewayClient,
): Promise<ScheduleDetail> {
  return client.get<ScheduleDetail>(`/triggers/${encodeURIComponent(id)}`);
}

/** Cancel a schedule. */
export async function cancelSchedule(
  id: string,
  client: GatewayClient,
): Promise<{ id: string; status: ScheduleStatus }> {
  return client.request<{ id: string; status: ScheduleStatus }>(
    "DELETE",
    `/triggers/${encodeURIComponent(id)}`,
  );
}

/**
 * Rotate a webhook trigger's signing secret (planned hygiene). The new secret is returned once,
 * with the hook `url` beside it; the previous secret keeps verifying for a bounded grace (24h) or
 * until `completeScheduleSecretRotation` confirms the sender has moved.
 */
export async function rotateScheduleSecret(
  id: string,
  client: GatewayClient,
): Promise<ScheduleDetail & WebhookSecretMaterial> {
  return client.post<ScheduleDetail & WebhookSecretMaterial>(
    `/triggers/${encodeURIComponent(id)}/secret/rotate`,
  );
}

/** End a rotation grace early: the previous secret stops verifying immediately. Idempotent. */
export async function completeScheduleSecretRotation(
  id: string,
  client: GatewayClient,
): Promise<ScheduleDetail> {
  return client.request<ScheduleDetail>(
    "DELETE",
    `/triggers/${encodeURIComponent(id)}/secret/previous`,
  );
}

/**
 * Revoke a webhook trigger (the compromise gesture): the hook stops verifying on the next request
 * and any open rotation grace dies with it. Irreversible — create a new webhook trigger instead.
 */
export async function revokeScheduleSecret(
  id: string,
  client: GatewayClient,
): Promise<ScheduleDetail> {
  return client.post<ScheduleDetail>(
    `/triggers/${encodeURIComponent(id)}/secret/revoke`,
  );
}

/** Validate a cron expression + timezone and preview the next occurrences (no persistence). */
export async function previewCron(
  opts: CronPreviewOptions,
  client: GatewayClient,
): Promise<CronPreview> {
  return client.post<CronPreview>("/triggers/preview-cron", opts);
}

function toQuery(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
