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

/** Example values from fleet.json. Real ids go in a gitignored fleet.local.json (see setup.ts). */
export const FLEET_CONFIG = fleet.config as { [K in ConfigKey]: unknown };

export type FleetConfigValues = { [K in ConfigKey]: unknown };

/** fleet.json's example values with a local override merged over them, key by key. */
export function mergeConfig(
  local: Partial<FleetConfigValues> | undefined,
): FleetConfigValues {
  return { ...FLEET_CONFIG, ...(local ?? {}) };
}

/** Keys that name things in your Slack and Linear workspaces; fleet.json can only hold examples. */
export const WORKSPACE_KEYS: readonly ConfigKey[] = [
  "linear.team_id",
  "linear.project_id",
  "channels.triage",
  "channels.customer",
  "oncall.slack_id",
];

/** Workspace keys still holding fleet.json's example value: setup refuses to seed those. */
export function exampleKeys(values: FleetConfigValues): ConfigKey[] {
  return WORKSPACE_KEYS.filter(
    (k) => JSON.stringify(values[k]) === JSON.stringify(FLEET_CONFIG[k]),
  );
}

export async function seedFleet(
  db: Db,
  setBy: string,
  opts: { overwrite?: boolean; values?: FleetConfigValues } = {},
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
