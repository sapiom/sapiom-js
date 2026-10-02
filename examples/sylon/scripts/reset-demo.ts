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

import { issueCard, issueCardText } from "../_shared/blocks";
import { getConfig } from "../_shared/config";
import { connectPostgres, resolveConnectionString } from "../_shared/db";
import { OPEN_STATUSES, getAccount, setStatus } from "../_shared/issues";
import { update } from "../_shared/slack";

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
    const open = await db.query<{
      id: string;
      number: number;
      status: string;
      title: string;
    }>(
      "select id, number, status, title from issues where status = any($1) order by number",
      [[...OPEN_STATUSES]],
    );
    if (!open.length) {
      console.log("no open issues");
      return;
    }
    const triage = await getConfig(db, "channels.triage");
    for (const row of open) {
      if (dryRun) {
        console.log(`would close #${row.number} (${row.status}): ${row.title}`);
        continue;
      }
      const issue = await setStatus(db, row.id, "closed");
      let card = "no card";
      if (issue.triageRootTs) {
        const account = await getAccount(db, issue.accountId);
        // A card that cannot be redrawn (deleted message, other channel) does not block the reset.
        card = await update(scriptCtx, {
          channel: triage,
          ts: issue.triageRootTs,
          text: issueCardText(issue, account),
          blocks: issueCard(issue, account),
        }).then(
          () => "card redrawn",
          (err: unknown) =>
            `card not redrawn: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.log(
        `closed #${row.number} (was ${row.status}, ${card}): ${row.title}`,
      );
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
