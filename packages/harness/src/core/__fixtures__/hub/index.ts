/**
 * Test fixture for the workspace-overview render's interconnection
 * detection (core/canvas-interconnections.test.ts).
 * Uses the current context API so both the manifest check and the syntax-only
 * interconnection detector exercise a supported authored call shape.
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const kickoff = defineStep({
  name: "kickoff",
  terminal: true,
  async run(_input, ctx) {
    await ctx.sapiom.agents.launch({ definition: "spoke-workflow" });
    return terminate({});
  },
});

export const agent = defineAgent({
  name: "hub-workflow",
  entry: "kickoff",
  steps: { kickoff },
});
