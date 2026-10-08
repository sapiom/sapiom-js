import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const work = defineStep({ name: "work", async run() { return terminate({}); } });

export const agent = defineAgent({ name: "survey", entry: "work", steps: { work } });
