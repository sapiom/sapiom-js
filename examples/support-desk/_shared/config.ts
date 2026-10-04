/**
 * Runtime config in the shared `config` table, so an onboarding flow can change it without a
 * redeploy. `pnpm run setup` seeds it; later an onboarding agent writes the same keys.
 */
import { z } from "zod/v4";

import type { Db } from "./db";
import { parseDocsSource } from "./docs";

/** SAP-3788 requires runtime-editable escalation thresholds and recipients. */
export const DeskEscalationSchema = z.object({
  levels: z
    .array(z.number().int().positive())
    .min(1)
    .max(5)
    .refine((l) => l.every((m, i) => i === 0 || m > l[i - 1]), {
      message: "levels must be strictly ascending",
    }),
  /** A Slack user group id (`S…`), mentioned in the triage thread. */
  groupId: z.string().min(1).optional(),
  oncallSlackId: z.string().min(1).optional(),
});
export type DeskEscalation = z.infer<typeof DeskEscalationSchema>;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const minuteOfDay = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const SlaTarget = z.object({
  firstResponseMinutes: z.number().int().min(1).max(10080),
  nextResponseMinutes: z.number().int().min(1).max(10080),
  /** Count only minutes inside `businessHours`; false counts wall-clock minutes. */
  businessHours: z.boolean(),
});

/**
 * Response targets per issue priority (`_shared/sla.ts` applies them). Lives here rather than in
 * `sla.ts` so `ConfigSchemas` never waits on a module that imports this one.
 */
export const SlaSchema = z.object({
  businessHours: z
    .object({
      timeZone: z.string().refine(validTimeZone, "unknown time zone"),
      /** 0 = Sunday .. 6 = Saturday. */
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .refine((d) => new Set(d).size === d.length, "days must be unique"),
      start: z.string().regex(HHMM, "use HH:MM"),
      end: z.string().regex(HHMM, "use HH:MM"),
    })
    // The bound keeps the business clock's walk short: see `addBusinessMinutes`.
    .refine((h) => minuteOfDay(h.end) - minuteOfDay(h.start) >= 60, {
      message: "end must be at least 60 minutes after start",
      path: ["end"],
    }),
  targets: z.object({
    urgent: SlaTarget,
    high: SlaTarget,
    normal: SlaTarget,
    low: SlaTarget,
  }),
});

/** A docs site's origin or its `llms.txt`, as {@link parseDocsSource} accepts it. */
export const DocsUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((url, ctx) => {
    try {
      parseDocsSource(url);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

export const ConfigSchemas = {
  /** Superseded by the desk's own value (`desks.linear_team_id`); read only when the desk has none. */
  "linear.team_id": z.string().min(1),
  /** Superseded by `desks.linear_project_id`. */
  "linear.project_id": z.string().min(1),
  /** Superseded by `desks.triage_channel`; the watchdog still falls back to it for alerts. */
  "channels.triage": z.string().min(1),
  "alerts.channel": z.string().min(1),
  /** `desk` is a desk slug; unlisted channels, and listed ones without it, get the default desk. */
  "channels.customer": z.array(
    z.object({
      channelId: z.string().min(1),
      accountName: z.string().min(1),
      desk: z.string().min(1).optional(),
    }),
  ),
  /** Superseded by `desks.oncall_slack_id`. */
  "oncall.slack_id": z.string().min(1),
  /** Superseded by `desks.nudge_minutes`. */
  "nudge.minutes": z.number().int().positive(),
  /** Controller gaps between repeat nudges: after round n, entry n-1; the last one repeats, `[]` nudges once. */
  "nudge.repeat_minutes": z.array(z.number().int().positive()),
  /** Slack workspaces whose members are our team. Unset: the workspace the connector is installed in. */
  "team.slack_team_ids": z.array(z.string().min(1)),
  /** Users treated as customers even when they post from our workspace, so one person can test with two accounts. */
  "customers.test_user_ids": z.array(z.string().min(1)),
  /** Whether intake adds 👀 / 🎫 to customer messages. Off for a shadow pilot that must leave no footprint. */
  "intake.reactions": z.boolean(),
  /** Tell the customer when engineering marks the Linear issue Done. Off until the desk is live. */
  "linear_sync.notify_customer": z.boolean(),
  /** Per desk slug; a desk without an entry never escalates to a person. */
  escalation: z.record(z.string().min(1), DeskEscalationSchema),
  /** Hours an open issue may age, by priority, before the daily digest flags it; unset keys keep the default. */
  "digest.sla_hours": z
    .object({
      urgent: z.number().positive(),
      high: z.number().positive(),
      normal: z.number().positive(),
      low: z.number().positive(),
    })
    .partial()
    .strict(),
  /** Response targets per priority. Unset: the controller nudges after the desk's `nudge_minutes`. */
  sla: SlaSchema,
  /**
   * The public docs the copilot may read and cite, for every desk: a site that publishes
   * `llms.txt`. Unset: drafts come from the team's articles only, and no docs are fetched or cited.
   */
  "knowledge.docs_url": DocsUrlSchema,
} as const;

/** Keys fleet.json may omit: readers apply a default, and setup seeds only the keys it has. */
export const OPTIONAL_KEYS: readonly ConfigKey[] = [
  "team.slack_team_ids",
  "channels.customer",
  "alerts.channel",
  "nudge.repeat_minutes",
  // Desk-owned now; a database installed before desks keeps them as fallbacks.
  "linear.team_id",
  "linear.project_id",
  "channels.triage",
  "oncall.slack_id",
  "nudge.minutes",
  "escalation",
  "digest.sla_hours",
  "sla",
  "knowledge.docs_url",
];
export type ConfigKey = keyof typeof ConfigSchemas;
export type ConfigValue<K extends ConfigKey> = z.infer<
  (typeof ConfigSchemas)[K]
>;

export class MissingConfigError extends Error {
  constructor(readonly key: string) {
    super(
      `config key '${key}' is not set in the fleet database; run \`pnpm run setup\` in examples/support-desk`,
    );
    this.name = "MissingConfigError";
  }
}

// One cache per Db, so a run reads each key once and a test's fresh Db never sees stale values.
const cache = new WeakMap<Db, Map<string, unknown>>();

function cacheFor(db: Db): Map<string, unknown> {
  let c = cache.get(db);
  if (!c) cache.set(db, (c = new Map()));
  return c;
}

export async function getConfig<K extends ConfigKey>(
  db: Db,
  key: K,
): Promise<ConfigValue<K>> {
  const c = cacheFor(db);
  if (c.has(key)) return c.get(key) as ConfigValue<K>;
  const rows = await db.query<{ value: unknown }>(
    "select value from config where key = $1",
    [key],
  );
  if (!rows[0]) throw new MissingConfigError(key);
  const value = ConfigSchemas[key].parse(rows[0].value) as ConfigValue<K>;
  c.set(key, value);
  return value;
}

/**
 * Like {@link getConfig}, but an unset key yields `fallback`. For keys added after a fleet was
 * installed: the live config table does not have them until setup re-seeds.
 */
export async function getConfigOr<K extends ConfigKey, F>(
  db: Db,
  key: K,
  fallback: F,
): Promise<ConfigValue<K> | F> {
  try {
    return await getConfig(db, key);
  } catch (err) {
    if (err instanceof MissingConfigError) return fallback;
    throw err;
  }
}

/**
 * Like {@link getConfigOr}, but always reads the row: for keys the Console edits from another
 * process while a step process stays warm on one shared `Db`.
 */
export async function getConfigFresh<K extends ConfigKey, F>(
  db: Db,
  key: K,
  fallback: F,
): Promise<ConfigValue<K> | F> {
  const rows = await db.query<{ value: unknown }>(
    "select value from config where key = $1",
    [key],
  );
  return rows[0]
    ? (ConfigSchemas[key].parse(rows[0].value) as ConfigValue<K>)
    : fallback;
}

export async function setConfig<K extends ConfigKey>(
  db: Db,
  key: K,
  value: ConfigValue<K>,
  setBy: string,
): Promise<void> {
  const parsed = ConfigSchemas[key].parse(value);
  await db.query(
    `insert into config (key, value, set_by, updated_at) values ($1, $2::text::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, set_by = excluded.set_by, updated_at = now()`,
    [key, JSON.stringify(parsed), setBy],
  );
  // Invalidate, never set: the write may sit in a transaction that later rolls back.
  cacheFor(db).delete(key);
}

/** Remove a key so readers fall back to their default. */
export async function deleteConfig(db: Db, key: ConfigKey): Promise<void> {
  await db.query("delete from config where key = $1", [key]);
  cacheFor(db).delete(key);
}

// Uncached: the Console edits it from another process while a step process can stay warm.
export async function escalations(db: Db): Promise<ConfigValue<"escalation">> {
  const rows = await db.query<{ value: unknown }>(
    "select value from config where key = 'escalation'",
  );
  return rows[0] ? ConfigSchemas.escalation.parse(rows[0].value) : {};
}

export async function deskEscalation(
  db: Db,
  slug: string,
): Promise<DeskEscalation | null> {
  return (await escalations(db))[slug] ?? null;
}

/** Lock the shared config row before merging so concurrent saves preserve other desks' entries. */
export async function setDeskEscalation(
  db: Db,
  slug: string,
  entry: DeskEscalation | null,
  setBy: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into config (key, value) values ('escalation', '{}'::jsonb) on conflict (key) do nothing",
    );
    const [row] = await tx.query<{ value: unknown }>(
      "select value from config where key = 'escalation' for update",
    );
    const all = { ...ConfigSchemas.escalation.parse(row.value) };
    if (entry) all[slug] = DeskEscalationSchema.parse(entry);
    else delete all[slug];
    await setConfig(tx, "escalation", all, setBy);
  });
  cacheFor(db).delete("escalation");
}

/** The account name for a customer channel, or null when the channel is not a customer channel. */
export async function customerChannel(
  db: Db,
  channelId: string,
): Promise<{ channelId: string; accountName: string; desk?: string } | null> {
  const channels = await getConfigOr(db, "channels.customer", []);
  return channels.find((c) => c.channelId === channelId) ?? null;
}
