import { defineOrchestration, defineStep, goto, terminate } from '@sapiom/orchestration';

const start = defineStep({
  name: 'start',
  next: ['finish'],
  async run(input, ctx) {
    ctx.logger.info('starting', { input });
    // Sapiom capabilities: ctx.sapiom.sandboxes.create(), ctx.sapiom.repositories.create()
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

export const orchestration = defineOrchestration({
  name: '__PROJECT_NAME__',
  entry: 'start',
  steps: { start, finish },
});
