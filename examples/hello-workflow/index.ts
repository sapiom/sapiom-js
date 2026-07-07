import {
  defineOrchestration,
  defineStep,
  terminate,
} from "@sapiom/orchestration";

/**
 * Hello Workflow — the minimal single-step Sapiom orchestration.
 *
 * The smallest valid definition: one terminal step, no capabilities. Use it to
 * confirm your MCP install and the build → deploy → run path work end to end
 * before reaching for a metered capability.
 *
 * Each step declares its allowed transitions (`next` / `terminal`); the return
 * type is derived from them, so an undeclared transition is a compile error.
 */
const greet = defineStep({
  name: "greet",
  next: [],
  terminal: true,
  async run(input: { name?: string }, ctx) {
    // Validate the input, defaulting to a friendly greeting when none is given.
    const name =
      typeof input?.name === "string" && input.name.trim().length > 0
        ? input.name.trim()
        : "world";
    ctx.logger.info("greeting", { name });
    return terminate({ greeting: `Hello, ${name}!` });
  },
});

export const orchestration = defineOrchestration({
  name: "hello-workflow",
  entry: "greet",
  steps: { greet },
});
