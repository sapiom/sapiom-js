// Test fixture — the launch target referenced by __fixtures__/hub/index.ts.
import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const run = defineStep({
  name: "run",
  terminal: true,
  async run() {
    return terminate({});
  },
});

export const agent = defineAgent({
  name: "spoke-workflow",
  entry: "run",
  steps: { run },
});
