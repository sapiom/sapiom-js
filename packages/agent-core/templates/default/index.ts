import { defineAgent, defineStep, goto, terminate } from '@sapiom/agent';
import { z } from 'zod/v4';

/**
 * The entry contract — your agent's PUBLIC API. This schema is what the Sapiom
 * dashboard's "Run once" form renders its fields from (one labelled field per
 * property, using its `.describe(...)`), and every run's input is validated
 * against it before `start` runs. Give a field a `.default(...)` so a zero-input
 * run still works and the declared default is the same value the code sees.
 * Replace `name` with your agent's real input.
 */
const entryInput = z.object({
  name: z
    .string()
    .default('world')
    .describe('Who to greet — the sample field this scaffold ships with.'),
});

const start = defineStep({
  name: 'start',
  next: ['finish'],
  inputSchema: entryInput,
  async run(input, ctx) {
    ctx.logger.info('starting', { input });
    // Sapiom capabilities: ctx.sapiom.sandboxes.create(), ctx.sapiom.repositories.create()
    return goto('finish', { greeting: `hello from Sapiom, ${input.name}` });
  },
});

const finish = defineStep({
  name: 'finish',
  next: [],
  terminal: true,
  async run() {
    return terminate({ done: true });
  },
});

export const agent = defineAgent({
  name: '__PROJECT_NAME__',
  entry: 'start',
  steps: { start, finish },
});
