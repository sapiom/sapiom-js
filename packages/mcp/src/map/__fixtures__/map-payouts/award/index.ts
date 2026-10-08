import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";

const PAYOUT_AGENT = "payout";

const pick = defineStep({
  name: "pick",
  async run(_input, ctx) {
    await ctx.sapiom.database.get("awards");
    return goto("pay", {});
  },
});

const pay = defineStep({
  name: "pay",
  async run(_input, ctx) {
    await ctx.sapiom.agents.run({ definition: PAYOUT_AGENT, input: {} });
    return terminate({});
  },
});

export const agent = defineAgent({
  name: "award",
  description: "Picks the week's award and pays it out.",
  entry: "pick",
  steps: { pick, pay },
});
