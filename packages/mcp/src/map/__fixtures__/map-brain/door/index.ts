import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const publish = defineStep({ name: "publish", async run() { return terminate({}); } });

export const agent = defineAgent({ name: "door", entry: "publish", steps: { publish } });
