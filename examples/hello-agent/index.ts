import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

/**
 * Hello Agent — the minimal single-step Sapiom agent.
 *
 * The smallest valid definition: one terminal step, no capabilities. Use it to
 * confirm your MCP install and the build → deploy → run path work end to end
 * before reaching for a metered capability.
 *
 * Each step declares its allowed transitions (`next` / `terminal`); the return
 * type is derived from them, so an undeclared transition is a compile error.
 */
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `name` defaults to the greeting
 * this scaffold ships with, so a zero-input run still produces a real result.
 */
const entryInput = z.object({
  name: z.string().default("world").describe("Who to greet."),
});

const greet = defineStep({
  name: "greet",
  inputSchema: entryInput,
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

export const agent = defineAgent({
  name: "hello-agent",
  entry: "greet",
  steps: { greet },
});
