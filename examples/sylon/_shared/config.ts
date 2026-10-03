/**
 * Runtime config in the shared `config` table, so an onboarding flow can change it without a
 * redeploy. `pnpm run setup` seeds it; later an onboarding agent writes the same keys.
 */
import { z } from "zod/v4";

import type { Db } from "./db";

export const ConfigSchemas = {
  "linear.team_id": z.string().min(1),
  "linear.project_id": z.string().min(1),
  "channels.triage": z.string().min(1),
  "alerts.channel": z.string().min(1),
  "channels.customer": z.array(
    z.object({ channelId: z.string().min(1), accountName: z.string().min(1) }),
  ),
  "oncall.slack_id": z.string().min(1),
  "nudge.minutes": z.number().int().positive(),
} as const;
/** Keys fleet.json may leave out: seeding skips them, and readers use {@link getConfigOr}. */
export const OPTIONAL_KEYS: readonly string[] = ["alerts.channel"];
export type ConfigKey = keyof typeof ConfigSchemas;
export type ConfigValue<K extends ConfigKey> = z.infer<
  (typeof ConfigSchemas)[K]
>;

export class MissingConfigError extends Error {
  constructor(readonly key: string) {
    super(
      `config key '${key}' is not set in the sylon database; run \`pnpm run setup\` in examples/sylon`,
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

/** {@link getConfig}, or `fallback` when the key is not set. A stored value that fails its schema still throws. */
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

/** The account name for a customer channel, or null when the channel is not a customer channel. */
export async function customerChannel(
  db: Db,
  channelId: string,
): Promise<{ channelId: string; accountName: string } | null> {
  const channels = await getConfig(db, "channels.customer");
  return channels.find((c) => c.channelId === channelId) ?? null;
}
