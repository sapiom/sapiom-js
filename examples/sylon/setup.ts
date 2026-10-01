/**
 * `pnpm run setup` (not `pnpm setup`, which is pnpm's own command).
 *
 * Config comes from fleet.local.json (your workspace's ids, gitignored) merged over fleet.json,
 * whose values are examples; setup stops if any key is still an example.
 *
 * E2 scope: resolve or create the `sylon` database, apply migrations, seed missing `config`
 * keys and `accounts` from fleet.json. Idempotent: a second run changes nothing.
 * `--overwrite` resets every config key to fleet.json.
 * E7 extends this into the full installer (link, deploy, triggers).
 *
 * Needs SAPIOM_API_KEY (an org key for the target org) in the environment. Prints no secrets.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@sapiom/tools";

import {
  connectPostgres,
  migrate,
  resolveConnectionString,
} from "./_shared/db";
import { exampleKeys, mergeConfig, seedFleet } from "./_shared/seed";

const LOCAL_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fleet.local.json",
);

/** Your workspace's ids: fleet.local.json `{ "config": { ... } }` over fleet.json's examples. */
function loadConfig() {
  const local = existsSync(LOCAL_FILE)
    ? (
        JSON.parse(readFileSync(LOCAL_FILE, "utf8")) as {
          config?: Record<string, unknown>;
        }
      ).config
    : undefined;
  const values = mergeConfig(local);
  const unset = exampleKeys(values);
  if (unset.length > 0) {
    throw new Error(
      `these config keys still hold fleet.json's example values: ${unset.join(", ")}. ` +
        `Put your workspace's ids in fleet.local.json (gitignored), as { "config": { "<key>": <value> } }.`,
    );
  }
  return values;
}

async function main() {
  const values = loadConfig();
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey)
    throw new Error("set SAPIOM_API_KEY to an org key for the target org");
  const sapiom = createClient({ apiKey });
  const connectionString = await resolveConnectionString({ sapiom } as never);
  const { db, close } = await connectPostgres(connectionString);
  try {
    const applied = await migrate(db);
    console.log(
      applied.length
        ? `migrations applied: ${applied.join(", ")}`
        : "migrations: up to date",
    );
    const overwrite = process.argv.includes("--overwrite");
    const { set, kept } = await seedFleet(db, "setup", { overwrite, values });
    console.log(
      `config set: ${set.join(", ") || "none"}; kept: ${kept.join(", ") || "none"}`,
    );
    const keys = await db.query<{ key: string }>(
      "select key from config order by key",
    );
    const accounts = await db.query<{ name: string; slack_channel_id: string }>(
      "select name, slack_channel_id from accounts order by name",
    );
    console.log(`config keys: ${keys.map((k) => k.key).join(", ")}`);
    console.log(
      `accounts: ${accounts.map((a) => `${a.name} (${a.slack_channel_id})`).join(", ")}`,
    );
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
