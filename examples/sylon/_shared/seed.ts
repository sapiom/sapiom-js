/**
 * Seed the database from fleet.json: config keys and one account per customer channel.
 * Run by `pnpm run setup` against the deployed database, and on every local trace's in-memory
 * database so `run_local` sees the same config as production.
 *
 * Only missing keys and accounts are written, so a rerun never reverts what an onboarding flow
 * changed. Pass `overwrite: true` (`pnpm run setup --overwrite`) to reset config to fleet.json.
 */
import fleet from "../fleet.json";
import { ConfigSchemas, setConfig, type ConfigKey } from "./config";
import type { Db } from "./db";
import { ensureAccount } from "./issues";

export const FLEET_CONFIG = fleet.config as { [K in ConfigKey]: unknown };

export async function seedFleet(
  db: Db,
  setBy: string,
  opts: { overwrite?: boolean; values?: { [K in ConfigKey]: unknown } } = {},
): Promise<{ set: ConfigKey[]; kept: ConfigKey[] }> {
  const values = opts.values ?? FLEET_CONFIG;
  const present = new Set(
    (await db.query<{ key: string }>("select key from config")).map(
      (r) => r.key,
    ),
  );
  const set: ConfigKey[] = [];
  const kept: ConfigKey[] = [];
  for (const key of Object.keys(ConfigSchemas) as ConfigKey[]) {
    if (values[key] === undefined)
      throw new Error(`fleet.json config is missing '${key}'`);
    if (present.has(key) && !opts.overwrite) {
      kept.push(key);
      continue;
    }
    await setConfig(
      db,
      key,
      ConfigSchemas[key].parse(values[key]) as never,
      setBy,
    );
    set.push(key);
  }
  const customers = ConfigSchemas["channels.customer"].parse(
    values["channels.customer"],
  );
  for (const c of customers)
    await ensureAccount(db, {
      name: c.accountName,
      slackChannelId: c.channelId,
    });
  return { set, kept };
}
