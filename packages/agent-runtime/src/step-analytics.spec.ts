/**
 * Step lifecycle usage analytics (`step.start` / `step.complete` /
 * `step.error`) emitted through the optional `analytics` sink.
 *
 * Also the zero-regression guard: without a sink (and with a throwing sink)
 * the walker behaves exactly as before the option existed.
 */

import type { AgentManifest } from '@sapiom/agent';
import { DIRECTIVE_KIND } from '@sapiom/agent';

import { ADVANCE_RESULT_KIND } from './advance-result.js';
import type { StepDispatcher } from './dispatch.js';
import { EXECUTION_STATUS } from './execution-state.js';
import {
  InMemoryExecutionStore,
  SyncInProcessDispatcher,
  resetIdCounter,
} from './in-memory-store.js';
import { AgentRunnerCore } from './runner-core.js';
import type { RuntimeAnalytics } from './stores.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedEvent {
  type: string;
  data: Record<string, unknown>;
}

function recorder(): { events: RecordedEvent[]; analytics: RuntimeAnalytics } {
  const events: RecordedEvent[] = [];
  return {
    events,
    analytics: {
      track(eventType, data) {
        events.push({ type: eventType, data: data ?? {} });
      },
    },
  };
}

function makeManifest(
  overrides: Partial<AgentManifest> & { steps: AgentManifest['steps'] },
): AgentManifest {
  return {
    protocol: 1,
    name: overrides.name ?? 'analytics-workflow',
    entry: overrides.entry ?? 'step1',
    sdkVersion: '0.0.0',
    artifact: { sha256: 'abc123', entryFile: 'workflow.mjs' },
    steps: overrides.steps,
  } as AgentManifest;
}

function twoStepManifest(): AgentManifest {
  return makeManifest({
    entry: 'step1',
    steps: {
      step1: {
        timeoutMs: null,
        inputSchema: null,
        transitions: [{ kind: 'continue', target: 'step2' }],
      },
      step2: {
        timeoutMs: null,
        inputSchema: null,
        transitions: [{ kind: 'terminate' }],
      },
    } as unknown as AgentManifest['steps'],
  });
}

function setupCore(analytics?: RuntimeAnalytics): {
  store: InMemoryExecutionStore;
  dispatcher: SyncInProcessDispatcher;
  core: AgentRunnerCore;
} {
  const store = new InMemoryExecutionStore();
  const dispatcher = new SyncInProcessDispatcher();
  const core = new AgentRunnerCore({ store, dispatcher, analytics });
  dispatcher.setCore(core);
  return { store, dispatcher, core };
}

beforeEach(() => {
  resetIdCounter();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRunnerCore step analytics', () => {
  it('emits step.start/step.complete per step with names, ids, and timing', async () => {
    const { events, analytics } = recorder();
    const { dispatcher, core } = setupCore(analytics);

    dispatcher.setSyncBody('step1', async () => ({
      output: { ok: 1 },
      directive: { kind: DIRECTIVE_KIND.CONTINUE, stepName: 'step2' },
    }));
    dispatcher.setSyncBody('step2', async () => ({
      output: { done: true },
      directive: { kind: DIRECTIVE_KIND.TERMINATE },
    }));

    const executionId = await core.createExecution(
      'analytics-workflow',
      'step1',
      { value: 1 },
      { manifest: twoStepManifest() },
    );
    await core.advance(executionId);
    await core.advance(executionId);

    expect(events.map((e) => [e.type, e.data.step])).toEqual([
      ['step.start', 'step1'],
      ['step.complete', 'step1'],
      ['step.start', 'step2'],
      ['step.complete', 'step2'],
    ]);
    for (const event of events) {
      expect(event.data.workflow_name).toBe('analytics-workflow');
      expect(event.data.execution_id).toBe(executionId);
      expect(event.data.attempt).toBe(0);
    }
    for (const finish of events.filter((e) => e.type === 'step.complete')) {
      expect(typeof finish.data.duration_ms).toBe('number');
      expect(finish.data.duration_ms as number).toBeGreaterThanOrEqual(0);
    }
    // Metadata only: no inputs/outputs/messages ride along.
    expect(Object.keys(events[1].data).sort()).toEqual([
      'attempt',
      'duration_ms',
      'execution_id',
      'step',
      'workflow_name',
    ]);
  });

  it('emits step.error with the error class name (never the message) per failed attempt', async () => {
    const { events, analytics } = recorder();
    const { store, dispatcher, core } = setupCore(analytics);

    dispatcher.setSyncBody('step1', async () => {
      const err = new Error('secret user detail');
      err.name = 'BoomError';
      throw err;
    });

    const manifest = makeManifest({
      entry: 'step1',
      steps: {
        step1: {
          timeoutMs: null,
          inputSchema: null,
          transitions: [{ kind: 'terminate' }],
        },
      } as unknown as AgentManifest['steps'],
    });

    const executionId = await core.createExecution('analytics-workflow', 'step1', {}, { manifest });
    // Default cap is 3 attempts (0, 1, 2); the third failure is terminal.
    await core.advance(executionId);
    await core.advance(executionId);
    await core.advance(executionId);

    const row = await store.loadExecution(executionId);
    expect(row?.status).toBe(EXECUTION_STATUS.FAILED);

    expect(events.map((e) => [e.type, e.data.attempt])).toEqual([
      ['step.start', 0],
      ['step.error', 0],
      ['step.start', 1],
      ['step.error', 1],
      ['step.start', 2],
      ['step.error', 2],
    ]);
    for (const failure of events.filter((e) => e.type === 'step.error')) {
      expect(failure.data.error_name).toBe('BoomError');
      expect(typeof failure.data.duration_ms).toBe('number');
      expect(JSON.stringify(failure.data)).not.toContain('secret user detail');
    }
  });

  it('emits step.error when the manifest input pre-gate rejects a dispatch', async () => {
    const { events, analytics } = recorder();
    const { store, dispatcher, core } = setupCore(analytics);

    dispatcher.setSyncBody('step1', async () => ({
      output: undefined,
      // Hand step2 an input its schema rejects.
      directive: { kind: DIRECTIVE_KIND.CONTINUE, stepName: 'step2', input: { count: 'nope' } },
    }));
    dispatcher.setSyncBody('step2', async () => ({
      output: undefined,
      directive: { kind: DIRECTIVE_KIND.TERMINATE },
    }));

    const manifest = makeManifest({
      entry: 'step1',
      steps: {
        step1: {
          timeoutMs: null,
          inputSchema: null,
          transitions: [{ kind: 'continue', target: 'step2' }],
        },
        step2: {
          timeoutMs: null,
          inputSchema: {
            type: 'object',
            properties: { count: { type: 'number' } },
            required: ['count'],
          },
          transitions: [{ kind: 'terminate' }],
        },
      } as unknown as AgentManifest['steps'],
    });

    const executionId = await core.createExecution('analytics-workflow', 'step1', {}, { manifest });
    await core.advance(executionId); // step1 succeeds
    await core.advance(executionId); // step2 dispatch fails the AJV pre-gate

    const row = await store.loadExecution(executionId);
    expect(row?.status).toBe(EXECUTION_STATUS.FAILED);

    expect(events.map((e) => [e.type, e.data.step])).toEqual([
      ['step.start', 'step1'],
      ['step.complete', 'step1'],
      ['step.start', 'step2'],
      ['step.error', 'step2'],
    ]);
    expect(events[3].data.error_name).toBe('StepInputValidationError');
  });

  it('emits step.error (no duration_ms) when the deadline sweep expires a dispatched step', async () => {
    const { events, analytics } = recorder();
    const store = new InMemoryExecutionStore();
    // A dispatcher that hands off and never completes — the attempt stays
    // DISPATCHED, exactly the state the deadline sweep exists for.
    const handOff: StepDispatcher = {
      async dispatch() {
        /* completion never arrives */
      },
    };
    const dispatcherCore = new AgentRunnerCore({ store, dispatcher: handOff, analytics });

    // timeoutMs in the past ⇒ the dispatch deadline is already blown the
    // moment the step is marked dispatched.
    const manifest = makeManifest({
      entry: 'step1',
      steps: {
        step1: {
          timeoutMs: -60_000,
          inputSchema: null,
          transitions: [{ kind: 'terminate' }],
        },
      } as unknown as AgentManifest['steps'],
    });

    const executionId = await dispatcherCore.createExecution('analytics-workflow', 'step1', {}, { manifest });
    const advanced = await dispatcherCore.advance(executionId);
    expect(advanced.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);

    // The sweep runs on a DIFFERENT core instance (in production, a different
    // process), so its start-time map is cold: the step.error must still be
    // emitted, just without duration_ms.
    const sweepCore = new AgentRunnerCore({ store, dispatcher: handOff, analytics });
    const result = await sweepCore.expireDispatchedStep(executionId);

    // Attempt 0 expired under the default cap of 3 ⇒ retained for retry.
    expect(result?.kind).toBe(ADVANCE_RESULT_KIND.RUNNING);
    const row = await store.loadExecution(executionId);
    expect(row?.status).toBe(EXECUTION_STATUS.RUNNING);

    expect(events.map((e) => [e.type, e.data.step])).toEqual([
      ['step.start', 'step1'],
      ['step.error', 'step1'],
    ]);
    const expiry = events[1];
    expect(expiry.data.error_name).toBe('DispatchDeadlineExceededError');
    expect(expiry.data.execution_id).toBe(executionId);
    expect(expiry.data.attempt).toBe(0);
    // Cold map ⇒ no duration_ms — pinned via the exact key set.
    expect(Object.keys(expiry.data).sort()).toEqual([
      'attempt',
      'error_name',
      'execution_id',
      'step',
      'workflow_name',
    ]);
  });

  it('emits nothing when no analytics sink is provided (previous behavior)', async () => {
    // The same workflow, run twice: once with a counting sentinel sink and
    // once with `analytics: undefined`. The sentinel arm proves this exact
    // workflow DOES emit when a sink exists, so the silent arm demonstrates
    // the invariant (absence of the sink is what silences emission) rather
    // than an accident of a workflow that never emits.
    const runFlow = async (analytics?: RuntimeAnalytics) => {
      const { store, dispatcher, core } = setupCore(analytics);
      dispatcher.setSyncBody('step1', async () => ({
        output: undefined,
        directive: { kind: DIRECTIVE_KIND.CONTINUE, stepName: 'step2' },
      }));
      dispatcher.setSyncBody('step2', async () => ({
        output: { done: true },
        directive: { kind: DIRECTIVE_KIND.TERMINATE },
      }));
      const executionId = await core.createExecution(
        'analytics-workflow',
        'step1',
        {},
        { manifest: twoStepManifest() },
      );
      await core.advance(executionId);
      await core.advance(executionId);
      const row = await store.loadExecution(executionId);
      return { core, row };
    };

    let sentinelCalls = 0;
    const sentinel: RuntimeAnalytics = {
      track() {
        sentinelCalls += 1;
      },
    };
    const withSink = await runFlow(sentinel);
    expect(sentinelCalls).toBe(4); // step.start + step.complete for each of 2 steps
    expect(withSink.row?.status).toBe(EXECUTION_STATUS.COMPLETED);

    const withoutSink = await runFlow(undefined);
    expect(withoutSink.row?.status).toBe(EXECUTION_STATUS.COMPLETED);
    expect(withoutSink.row?.output).toEqual(withSink.row?.output);
    // Belt-and-braces: without a sink there is no object to call `track` on,
    // and the emit helpers bail at their `if (!analytics)` guard before any
    // bookkeeping — so the start-time map must stay untouched. (Private
    // peek; "nothing happened" has no public side channel to observe.)
    const startTimes = (
      withoutSink.core as unknown as { stepStartedAt: Map<string, number> }
    ).stepStartedAt;
    expect(startTimes.size).toBe(0);
  });

  it('a throwing sink never affects the run (fault injection)', async () => {
    let calls = 0;
    const hostileSink: RuntimeAnalytics = {
      track() {
        calls += 1;
        throw new Error('collector exploded');
      },
    };
    const { store, dispatcher, core } = setupCore(hostileSink);

    dispatcher.setSyncBody('step1', async () => ({
      output: undefined,
      directive: { kind: DIRECTIVE_KIND.CONTINUE, stepName: 'step2' },
    }));
    dispatcher.setSyncBody('step2', async () => ({
      output: { done: true },
      directive: { kind: DIRECTIVE_KIND.TERMINATE },
    }));

    const executionId = await core.createExecution(
      'analytics-workflow',
      'step1',
      {},
      { manifest: twoStepManifest() },
    );
    await core.advance(executionId);
    await core.advance(executionId);

    expect(calls).toBeGreaterThan(0); // the sink really was exercised
    const row = await store.loadExecution(executionId);
    expect(row?.status).toBe(EXECUTION_STATUS.COMPLETED);
    expect(row?.output).toEqual({ done: true });
  });
});
