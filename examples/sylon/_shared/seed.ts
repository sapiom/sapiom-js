/**
 * Seed the database from fleet.json: desks, config keys and one account per customer channel.
 * Run by `pnpm run setup` against the deployed database, and on every local trace's in-memory
 * database so `run_local` sees the same config as production.
 *
 * Only missing keys and accounts are written, so a rerun never reverts what an onboarding flow
 * changed. Pass `overwrite: true` (`pnpm run setup --overwrite`) to reset config to fleet.json.
 */
import fleet from "../fleet.json";
import {
  ConfigSchemas,
  deleteConfig,
  OPTIONAL_KEYS,
  setConfig,
  type ConfigKey,
} from "./config";
import type { Db } from "./db";
import { defaultDesk, deskBySlug, upsertDesk, type DeskInput } from "./desks";
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

/** A desk as written in fleet.json / fleet.local.json (`default` is the file's name for `isDefault`). */
export interface FleetDesk {
  slug: string;
  name: string;
  triageChannel: string;
  linearTeamId?: string;
  linearProjectId?: string;
  oncallSlackId?: string;
  nudgeMinutes?: number;
  default?: boolean;
}

/** fleet.json's example desks. A local file's `desks` replaces them whole, not field by field. */
export const FLEET_DESKS = fleet.desks as FleetDesk[];

export function mergeDesks(local: FleetDesk[] | undefined): FleetDesk[] {
  return local ?? FLEET_DESKS;
}

const toDeskInput = (d: FleetDesk): DeskInput => ({
  slug: d.slug,
  name: d.name,
  triageChannel: d.triageChannel,
  linearTeamId: d.linearTeamId,
  linearProjectId: d.linearProjectId,
  oncallSlackId: d.oncallSlackId,
  nudgeMinutes: d.nudgeMinutes,
  isDefault: d.default,
});

/** Keys that name things in your Slack workspace; fleet.json can only hold examples. */
export const WORKSPACE_KEYS: readonly ConfigKey[] = ["channels.customer"];

/** The desk fields that name things in your Slack and Linear workspaces. */
const DESK_WORKSPACE_FIELDS = [
  "triageChannel",
  "linearTeamId",
  "linearProjectId",
  "oncallSlackId",
] as const;

/**
 * Workspace values still holding a fleet.json example: setup refuses to seed those. A
 * customer-channel list is flagged when any entry still uses an example channel id, even if real
 * entries were added beside it. A desk field is reported as `desks.<slug>.<field>`.
 */
export function exampleKeys(
  values: FleetConfigValues,
  desks: readonly FleetDesk[],
): string[] {
  const exampleChannels = new Set(
    (FLEET_CONFIG["channels.customer"] as { channelId: string }[]).map(
      (c) => c.channelId,
    ),
  );
  const keys: string[] = WORKSPACE_KEYS.filter((k) => {
    if (k === "channels.customer") {
      const list = values[k];
      return (
        !Array.isArray(list) ||
        list.some((c) =>
          exampleChannels.has((c as { channelId?: string }).channelId ?? ""),
        )
      );
    }
    return JSON.stringify(values[k]) === JSON.stringify(FLEET_CONFIG[k]);
  });
  for (const desk of desks)
    for (const field of DESK_WORKSPACE_FIELDS) {
      const value = desk[field];
      if (value && FLEET_DESKS.some((e) => e[field] === value))
        keys.push(`desks.${desk.slug}.${field}`);
    }
  return keys;
}

export async function seedFleet(
  db: Db,
  setBy: string,
  opts: {
    overwrite?: boolean;
    values?: FleetConfigValues;
    desks?: readonly FleetDesk[];
  } = {},
): Promise<{
  set: ConfigKey[];
  kept: ConfigKey[];
  removed: ConfigKey[];
  desksSet: string[];
  desksKept: string[];
}> {
  const values = opts.values ?? FLEET_CONFIG;
  const desks = opts.desks ?? FLEET_DESKS;
  const present = new Set(
    (await db.query<{ key: string }>("select key from config")).map(
      (r) => r.key,
    ),
  );
  const set: ConfigKey[] = [];
  const removed: ConfigKey[] = [];
  const kept: ConfigKey[] = [];
  for (const key of Object.keys(ConfigSchemas) as ConfigKey[]) {
    if (values[key] === undefined && OPTIONAL_KEYS.includes(key)) {
      // An overwrite resets to the file, so an optional key the file omits must go, letting
      // readers fall back to their default.
      if (opts.overwrite && present.has(key)) {
        await deleteConfig(db, key);
        removed.push(key);
      }
      continue;
    }
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
  // Desks first: an account's channel entry names its desk.
  const desksSet: string[] = [];
  const desksKept: string[] = [];
  for (const d of desks) {
    const res = await upsertDesk(db, toDeskInput(d), {
      overwrite: opts.overwrite,
    });
    (res.created || res.updated ? desksSet : desksKept).push(d.slug);
  }
  // A file with desks but no `default` still needs one, or unlisted channels have no desk.
  if (desks.length && !(await defaultDesk(db)))
    await upsertDesk(
      db,
      { ...toDeskInput(desks[0]), isDefault: true },
      { overwrite: true },
    );
  const customers = ConfigSchemas["channels.customer"].parse(
    values["channels.customer"] ?? [],
  );
  for (const c of customers) {
    const desk = c.desk ? await deskBySlug(db, c.desk) : null;
    if (c.desk && !desk)
      throw new Error(
        `channels.customer '${c.channelId}' names desk '${c.desk}', which is not defined under "desks"`,
      );
    await ensureAccount(db, {
      name: c.accountName,
      slackChannelId: c.channelId,
      deskId: desk?.id,
    });
  }
  return { set, kept, removed, desksSet, desksKept };
}
