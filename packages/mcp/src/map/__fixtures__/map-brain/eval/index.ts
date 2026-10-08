import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

const entryInput = z.object({
  definition: z.string().default("propose").describe("Slug of the agent to evaluate."),
});

const fanout = defineStep({
  name: "fanout",
  inputSchema: entryInput,
  async run(input: z.infer<typeof entryInput>, ctx) {
    await ctx.sapiom.agents.launch({ definition: input.definition, input: {} });
    return terminate({});
  },
});

export const agent = defineAgent({ name: "eval", entry: "fanout", steps: { fanout } });
