/**
 * Test fixture for the workspace-overview render's interconnection
 * detection (core/canvas-interconnections.test.ts, core/canvas-render.test.ts).
 * `orchestrations` below is a local stub, not the real `@sapiom/tools`
 * package — the interconnection detector is a text grep, not a type-aware
 * analysis, so it only needs a matching call shape to appear somewhere in
 * the source; it never actually resolves or calls the referenced package.
 */
import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const orchestrations = { launch: async (_spec: { definition: string }) => ({}) };

const kickoff = defineStep({
  name: "kickoff",
  terminal: true,
  async run() {
    await orchestrations.launch({ definition: "spoke-workflow" });
    return terminate({});
  },
});

export const agent = defineAgent({
  name: "hub-workflow",
  entry: "kickoff",
  steps: { kickoff },
});
