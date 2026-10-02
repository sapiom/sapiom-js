/**
 * `pnpm run reset-demo`: close every open issue, so the demo starts clean.
 *
 * Intake links a new top-level customer message to any open issue of the account that Jev judges
 * to be the same problem, so issues left open from a rehearsal would capture the demo's messages.
 * Each issue moves through `setStatus` (the status machine), and its triage card is redrawn from
 * the row so the channel shows it Closed. `--dry-run` lists what would close.
 *
 * Needs SAPIOM_API_KEY (an org key for the target org). Linear issues are left as they are.
 */
import { createClient } from "@sapiom/tools";

import { connectPostgres, resolveConnectionString } from "../_shared/db";
import { resetBoard } from "../_shared/reset";

const scriptCtx = { isLocalTrace: false, logger: console } as never;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey)
    throw new Error("set SAPIOM_API_KEY to an org key for the target org");
  const sapiom = createClient({ apiKey });
  const { db, close } = await connectPostgres(
    await resolveConnectionString({ sapiom } as never),
  );
  try {
    const outcomes = await resetBoard(db, scriptCtx, { dryRun });
    if (!outcomes.length) console.log("no open issues");
    for (const o of outcomes)
      console.log(
        dryRun
          ? `would close #${o.number} (${o.was}): ${o.title}`
          : `closed #${o.number} (was ${o.was}, ${o.card}): ${o.title}`,
      );
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
