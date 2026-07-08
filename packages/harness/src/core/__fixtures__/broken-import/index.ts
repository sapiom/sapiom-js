// Fixture: imports a package that can't be resolved — exercises the "no
// node_modules" / unresolvable-dependency degradation path (BUNDLE_FAILED).
import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { somethingThatDoesNotExist } from "@sapiom/this-package-does-not-exist";

const step = defineStep({
  name: "step",
  terminal: true,
  async run() {
    void somethingThatDoesNotExist;
    return terminate({});
  },
});

export const agent = defineAgent({
  name: "broken-import",
  entry: "step",
  steps: { step },
});
