/**
 * `pnpm run setup` (not `pnpm setup`, which is pnpm's own command).
 *
 * E2 scope: resolve or create the `sylon` database, apply migrations, seed `config` and
 * `accounts` from fleet.json. Idempotent: a second run changes nothing but `updated_at`.
 * E7 extends this into the full installer (link, deploy, triggers).
 *
 * Needs SAPIOM_API_KEY (an org key for the target org) in the environment. Prints no secrets.
 */
import { createClient } from "@sapiom/tools";

import {
  connectPostgres,
  migrate,
  resolveConnectionString,
} from "./_shared/db";
import { seedFleet } from "./_shared/seed";

async function main() {
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
    await seedFleet(db, "setup");
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
