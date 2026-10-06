import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";
import { EXPERT_SLUGS } from "./contracts";

const ANALYZE_SLUG = "analyze";

async function launchChild(ctx: any, spec: { definition: string; input: unknown }) {
  return ctx.sapiom.agents.launch(spec);
}

const start = defineStep({
  name: "start",
  async run(_input, ctx) {
    await launchChild(ctx, { definition: ANALYZE_SLUG, input: {} });
    return goto("experts", {});
  },
});

const experts = defineStep({
  name: "experts",
  async run(input: { ids: string[] }, ctx) {
    await Promise.all(input.ids.map((id) => ctx.sapiom.agents.run({ definition: EXPERT_SLUGS[id], input: {} })));
    return terminate({});
  },
});

const dynamic = defineStep({
  name: "dynamic",
  async run(input: { target: string }, ctx) {
    await ctx.sapiom.agents.run({ definition: `${input.target}-v2`, input: {} });
    return terminate({});
  },
});

export const agent = defineAgent({ name: "propose", entry: "start", steps: { start, experts, dynamic } });
