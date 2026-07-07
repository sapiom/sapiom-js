import { defineAgent, defineStep, goto, terminate } from '@sapiom/agent';

/**
 * A minimal Sapiom agent: two steps, `start → finish`.
 *
 * Each step declares its allowed transitions (`next` / `terminal` / `canFail` /
 * `pause`); the return type is derived from them, so an undeclared transition is
 * a compile error. Inside any step the full Sapiom tool catalog is available,
 * pre-auth'd and tenant-scoped, on `ctx.sapiom` — no credentials to wire.
 */
const start = defineStep({
  name: 'start',
  next: ['finish'],
  async run(input, ctx) {
    ctx.logger.info('starting', { input });

    // Sapiom capabilities are available on ctx.sapiom (metered + traced):
    //   const box = await ctx.sapiom.sandboxes.create({ name: 'demo' });
    //   const repo = await ctx.sapiom.repositories.create('my-repo');

    return goto('finish', { greeting: 'hello from Sapiom' });
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
