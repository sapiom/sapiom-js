import { defineAgent, defineStep, terminate } from "@sapiom/agent";

// Shares a database and a vault key with payout: a chip on both cards, never one system.
const report = defineStep({
  name: "report",
  async run(_input, ctx) {
    await ctx.sapiom.vault.get("PAYMENTS_KEY");
    await ctx.sapiom.database.get("office");
    // A slug in a string is not a call.
    ctx.logger.info("see award for context");
    return terminate({});
  },
});

export const agent = defineAgent({ name: "ledger-report", entry: "report", steps: { report } });
