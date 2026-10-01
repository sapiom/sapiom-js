/**
 * Seed the database from fleet.json: config keys and one account per customer channel.
 * Run by `pnpm run setup` against the deployed database, and on every local trace's in-memory
 * database so `run_local` sees the same config as production.
 */
import fleet from "../fleet.json";
import { ConfigSchemas, setConfig, type ConfigKey } from "./config";
import type { Db } from "./db";
import { upsertAccount } from "./issues";

export const FLEET_CONFIG = fleet.config as { [K in ConfigKey]: unknown };

export async function seedFleet(
  db: Db,
  setBy: string,
  values: { [K in ConfigKey]: unknown } = FLEET_CONFIG,
): Promise<void> {
  for (const key of Object.keys(ConfigSchemas) as ConfigKey[]) {
    if (values[key] === undefined)
      throw new Error(`fleet.json config is missing '${key}'`);
    await setConfig(
      db,
      key,
      ConfigSchemas[key].parse(values[key]) as never,
      setBy,
    );
  }
  const customers = ConfigSchemas["channels.customer"].parse(
    values["channels.customer"],
  );
  for (const c of customers)
    await upsertAccount(db, {
      name: c.accountName,
      slackChannelId: c.channelId,
    });
}
