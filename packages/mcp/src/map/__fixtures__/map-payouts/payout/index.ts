import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const send = defineStep({
  name: "send",
  async run(_input, ctx) {
    await ctx.sapiom.vault.get("PAYMENTS_KEY");
    await ctx.sapiom.database.get("office");
    return terminate({});
  },
});

export const agent = defineAgent({ name: "payout", entry: "send", steps: { send } });
