import {
  buildManifest,
  defineOrchestration,
  defineStep,
  fail,
  goto,
  pauseUntilSignal,
  terminate,
  workflowManifestSchema,
  type OrchestrationDefinition,
  type WorkflowManifest,
} from '@sapiom/orchestration';
import { CODING_RESULT_SIGNAL } from '@sapiom/tools';

import { runLocal } from './run-local.js';
import type { StubFile } from './stubs.js';

function manifestFor(def: OrchestrationDefinition): WorkflowManifest {
  return workflowManifestSchema.parse(
    buildManifest(def, { sdkVersion: '0.0.0-test', artifact: { sha256: 'x', entryFile: 'def.mjs' } }),
  ) as WorkflowManifest;
}

describe('runLocal', () => {
  // The regression test: a handle-heavy workflow (the repo-helper shape) runs to
  // completion on built-in defaults — including `repo.pushFromSandbox(...)`, the
  // instance method that previously had no method body under stubs.
  it('runs a handle-using workflow to completion on defaults (incl. repo.pushFromSandbox)', async () => {
    const prepare = defineStep({
      name: 'prepare',
      next: ['work'],
      async run(_input, ctx) {
        const repos = await ctx.sapiom.repositories.list();
        const repo = repos.find((r) => r.slug === 'demo') ?? (await ctx.sapiom.repositories.create('demo'));
        return goto('work', { slug: repo.slug, cloneUrl: repo.cloneUrl });
      },
    });
    const work = defineStep({
      name: 'work',
      next: ['done'],
      canFail: true,
      async run(input: { slug: string; cloneUrl: string }, ctx) {
        const repo = ctx.sapiom.repositories.attach(input.slug, input.cloneUrl);
        const run = await ctx.sapiom.agent.coding.run({ task: 'add a README', gitRepository: repo });
        if (run.status !== 'completed' || !run.result?.success) return fail('agent did not succeed');
        const push = await repo.pushFromSandbox(run.sandbox, { message: 'docs' });
        return goto('done', { pushed: push.pushed, sandbox: run.sandbox.name });
      },
    });
    const done = defineStep({
      name: 'done',
      next: [],
      terminal: true,
      async run(input: { pushed: boolean; sandbox: string }) {
        return terminate({ pushed: input.pushed, sandbox: input.sandbox });
      },
    });
    const def = defineOrchestration({ name: 'repo-helper', entry: 'prepare', steps: { prepare, work, done } });

    const result = await runLocal({ definition: def, manifest: manifestFor(def), input: {} });

    expect(result.outcome).toBe('completed');
    expect(result.output).toEqual({ pushed: true, sandbox: 'stub-sandbox' });
    expect(result.steps.map((s) => [s.step, s.status])).toEqual([
      ['prepare', 'succeeded'],
      ['work', 'succeeded'],
      ['done', 'succeeded'],
    ]);
  });

  it('an override controls a branch (repositories.list returns an existing repo)', async () => {
    const prepare = defineStep({
      name: 'prepare',
      next: [],
      terminal: true,
      async run(_input, ctx) {
        const repos = await ctx.sapiom.repositories.list();
        const found = repos.find((r) => r.slug === 'demo');
        return terminate({ cloneUrl: found?.cloneUrl ?? '(none)' });
      },
    });
    const def = defineOrchestration({ name: 'find', entry: 'prepare', steps: { prepare } });

    const stubs: StubFile = {
      version: 1,
      steps: { prepare: { 'repositories.list': [{ slug: 'demo', cloneUrl: 'https://git/demo.git', status: 'active' }] } },
    };
    const result = await runLocal({ definition: def, manifest: manifestFor(def), input: {}, stubs });

    expect(result.outcome).toBe('completed');
    expect(result.output).toEqual({ cloneUrl: 'https://git/demo.git' });
  });

  it('routes a fail() directive to a failed outcome without retrying', async () => {
    let runs = 0;
    const decide = defineStep({
      name: 'decide',
      next: [],
      terminal: true,
      canFail: true,
      async run(_input, ctx) {
        runs++;
        const run = await ctx.sapiom.agent.coding.run({ task: 't' });
        return run.result?.success ? terminate({ ok: true }) : fail('agent did not succeed');
      },
    });
    const def = defineOrchestration({ name: 'gate', entry: 'decide', steps: { decide } });

    // Override the coding run to report failure → the step takes its fail() branch.
    const stubs: StubFile = {
      version: 1,
      steps: { decide: { 'agent.coding.run': { status: 'failed', result: { success: false }, sandbox: { name: 'sb' } } } },
    };
    const result = await runLocal({ definition: def, manifest: manifestFor(def), input: {}, stubs });

    expect(result.outcome).toBe('failed');
    expect(runs).toBe(1);
  });

  // The canonical coding pattern: launch + pauseUntilSignal + resume. The local
  // runner auto-resumes with the stub coding result, so it completes locally.
  it('auto-resumes a pauseUntilSignal(launch) workflow with the stub result', async () => {
    const launch = defineStep({
      name: 'launch',
      next: [],
      pause: { signal: CODING_RESULT_SIGNAL, resumeStep: 'review' },
      async run(_input, ctx) {
        return pauseUntilSignal(ctx.sapiom.agent.coding.launch({ task: 'do the thing' }), { resumeStep: 'review' });
      },
    });
    const review = defineStep({
      name: 'review',
      next: [],
      terminal: true,
      async run(input) {
        // `input` is the resumed signal payload — the coding-run result.
        const r = input as { status?: string; result?: { success?: boolean } };
        return terminate({ resumedStatus: r.status, success: r.result?.success });
      },
    });
    const def = defineOrchestration({ name: 'coding-pause', entry: 'launch', steps: { launch, review } });

    const result = await runLocal({ definition: def, manifest: manifestFor(def), input: {} });

    expect(result.outcome).toBe('completed');
    expect(result.output).toEqual({ resumedStatus: 'completed', success: true });
    expect(result.steps.map((s) => s.step)).toEqual(['launch', 'review']);
  });

  it('retries a thrown step and fails at the cap', async () => {
    let runs = 0;
    const flaky = defineStep({
      name: 'flaky',
      next: [],
      terminal: true,
      async run() {
        runs++;
        throw new Error('boom');
      },
    });
    const def = defineOrchestration({ name: 'unreliable', entry: 'flaky', steps: { flaky } });

    const result = await runLocal({ definition: def, manifest: manifestFor(def), input: {}, maxAttemptsPerStep: 2 });

    expect(result.outcome).toBe('failed');
    expect(runs).toBe(2);
  });
});
