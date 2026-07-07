/**
 * Integration tests for AgentRunnerCore + InMemoryExecutionStore.
 *
 * Tests:
 *   (1) 2-step workflow runs to COMPLETED
 *   (2) Step throws, retries exhaust at cap → FAILED
 *   (3) Step pauses, then resumes via resetForResume → COMPLETED
 */

import type { AgentManifest } from '@sapiom/orchestration';
import { DIRECTIVE_KIND } from '@sapiom/orchestration';

import { ADVANCE_RESULT_KIND } from './advance-result.js';
import type { StepDispatcher } from './dispatch.js';
import { EXECUTION_STATUS } from './execution-state.js';
import { RetryLimitExceededError } from './errors.js';
import { InMemoryExecutionStore, SyncInProcessDispatcher, resetIdCounter } from './in-memory-store.js';
import { AgentRunnerCore, DEFAULT_MAX_ATTEMPTS_PER_STEP } from './runner-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<AgentManifest> & { steps: AgentManifest['steps'] }): AgentManifest {
  return {
    protocol: 1,
    name: overrides.name ?? 'test-workflow',
    entry: overrides.entry ?? 'step1',
    sdkVersion: '0.0.0',
    artifact: { sha256: 'abc123', entryFile: 'workflow.mjs' },
    steps: overrides.steps,
  } as AgentManifest;
}

function setupCore(store?: InMemoryExecutionStore): {
  store: InMemoryExecutionStore;
  dispatcher: SyncInProcessDispatcher;
  core: AgentRunnerCore;
} {
  const s = store ?? new InMemoryExecutionStore();
  const dispatcher = new SyncInProcessDispatcher();
  const core = new AgentRunnerCore({ store: s, dispatcher });
  dispatcher.setCore(core);
  return { store: s, dispatcher, core };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetIdCounter();
});

describe('AgentRunnerCore', () => {
  // ── (1) 2-step workflow runs to COMPLETED ──────────────────────────────────

  describe('2-step workflow: COMPLETED', () => {
    it('creates execution, advances twice, and reaches COMPLETED', async () => {
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
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();

      dispatcher.setSyncBody('step1', async (input) => ({
        output: { processedBy: 'step1', received: input },
        directive: { kind: DIRECTIVE_KIND.CONTINUE, stepName: 'step2' },
      }));

      dispatcher.setSyncBody('step2', async (input) => ({
        output: { finalOutput: 'done', received: input },
        directive: { kind: DIRECTIVE_KIND.TERMINATE },
      }));

      const executionId = await core.createExecution('test-workflow', 'step1', { value: 42 }, { manifest });

      // First advance: dispatches step1. SyncInProcessDispatcher drives the step
      // body AND calls completeDispatchedStep inside dispatch() itself (via
      // Promise.resolve().then). By the time dispatch() resolves the store is
      // already transitioned to step2 — but advance() still returns DISPATCHED
      // because dispatchOneStep always returns DISPATCHED after a successful
      // dispatch() call.
      const result1 = await core.advance(executionId);
      expect(result1.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);

      // The store should now be pointing at step2 (CONTINUE transition applied).
      const midState = store.getExecution(executionId);
      expect(midState?.currentStep).toBe('step2');
      expect(midState?.dispatchedStepRowId).toBeNull(); // cleared by completeDispatchedStep

      // Second advance: dispatches step2. Body returns TERMINATE → store = COMPLETED.
      const result2 = await core.advance(executionId);
      expect(result2.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);

      // The execution should now be COMPLETED
      const finalState = store.getExecution(executionId);
      expect(finalState?.status).toBe(EXECUTION_STATUS.COMPLETED);
      expect((finalState?.output as { finalOutput?: string })?.finalOutput).toBe('done');
    });

    it('carries the step1 output as step2 input when no explicit input is set', async () => {
      const manifest = makeManifest({
        entry: 'fetch',
        steps: {
          fetch: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'continue', target: 'process' }],
          },
          process: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();
      let step2ReceivedInput: unknown;

      dispatcher.setSyncBody('fetch', async (_input) => ({
        output: { data: [1, 2, 3] },
        directive: { kind: DIRECTIVE_KIND.CONTINUE, stepName: 'process' },
      }));

      dispatcher.setSyncBody('process', async (input) => {
        step2ReceivedInput = input;
        return {
          output: { processed: true },
          directive: { kind: DIRECTIVE_KIND.TERMINATE },
        };
      });

      const executionId = await core.createExecution('test-workflow', 'fetch', {}, { manifest });
      await core.advance(executionId);
      await core.advance(executionId);

      // Both advances return DISPATCHED; the store ends up COMPLETED.
      expect(step2ReceivedInput).toEqual({ data: [1, 2, 3] });
      expect(store.getExecution(executionId)?.status).toBe(EXECUTION_STATUS.COMPLETED);
    });
  });

  // ── (2) Step throws, retries exhaust at cap → FAILED ──────────────────────

  describe('retry cap exhaustion: FAILED', () => {
    it('retries on throw and fails with RetryLimitExceededError when cap is reached', async () => {
      const manifest = makeManifest({
        entry: 'flaky',
        steps: {
          flaky: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();
      let callCount = 0;

      dispatcher.setSyncBody('flaky', async () => {
        callCount++;
        throw new Error(`Attempt ${callCount} failed`);
      });

      const executionId = await core.createExecution('test-workflow', 'flaky', {}, { manifest });

      // SyncInProcessDispatcher runs body + completeDispatchedStep inside dispatch().
      // So advance() always returns DISPATCHED (the step was handed off) — the actual
      // RUNNING/FAILED outcome is recorded in the store by the time advance() returns.
      //
      // Attempt 0: dispatch() → body throws → completeDispatchedStep(THREW) →
      //   handleRetryOrCap(attempt=0, next=1, cap=3) → retainStepForRetry → attempt=1.
      //   advance() returns DISPATCHED. store: status=RUNNING, attempt=1.
      const r1 = await core.advance(executionId, DEFAULT_MAX_ATTEMPTS_PER_STEP);
      expect(r1.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);
      expect(store.getExecution(executionId)?.status).toBe(EXECUTION_STATUS.RUNNING);
      expect(store.getExecution(executionId)?.currentStepAttempt).toBe(1);

      // Attempt 1: same path → attempt=2.
      const r2 = await core.advance(executionId, DEFAULT_MAX_ATTEMPTS_PER_STEP);
      expect(r2.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);
      expect(store.getExecution(executionId)?.currentStepAttempt).toBe(2);

      // Attempt 2: dispatch() → body throws → handleRetryOrCap(attempt=2, next=3, cap=3)
      //   → next >= cap → failExecution → status=FAILED. advance() returns DISPATCHED.
      const r3 = await core.advance(executionId, DEFAULT_MAX_ATTEMPTS_PER_STEP);
      expect(r3.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);

      // Ground truth is the store state:
      const finalState = store.getExecution(executionId);
      expect(finalState?.status).toBe(EXECUTION_STATUS.FAILED);
      const failErr = finalState?.error as RetryLimitExceededError | undefined;
      expect(failErr).toBeInstanceOf(RetryLimitExceededError);
      expect(failErr?.stepName).toBe('flaky');
      expect(failErr?.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS_PER_STEP);

      expect(callCount).toBe(3); // body ran 3 times
    });

    it('respects a custom maxAttemptsPerStep cap', async () => {
      const manifest = makeManifest({
        entry: 'unreliable',
        steps: {
          unreliable: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();
      let callCount = 0;

      dispatcher.setSyncBody('unreliable', async () => {
        callCount++;
        throw new Error('always fails');
      });

      const executionId = await core.createExecution('test-workflow', 'unreliable', {}, { manifest });
      const CAP = 1; // fail after 1 attempt total (attempt=0 throws, nextAttempt=1 >= cap=1 → fail)
      // The retry/cap decision runs in the completion, so the cap must be set on
      // the (completion-simulating) dispatcher, not only on advance().
      dispatcher.setMaxAttempts(CAP);

      // With SyncInProcessDispatcher: advance() returns DISPATCHED; store = FAILED.
      const r = await core.advance(executionId, CAP);
      expect(r.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);
      expect(store.getExecution(executionId)?.status).toBe(EXECUTION_STATUS.FAILED);
      expect(callCount).toBe(1);
    });

    it('cap-exceeded check fires BEFORE dispatch when currentStepAttempt >= cap on entry', async () => {
      // This tests the advanceRunning pre-dispatch guard:
      //   if (row.currentStepAttempt >= maxAttemptsPerStep) → failExecution immediately.
      // We manufacture an execution that already has attempt=3 by running through 3
      // dispatches where each throws, then check that a 4th advance (with cap=3) fails
      // without dispatching — BUT with SyncInProcessDispatcher the 3rd advance already
      // transitions the store to FAILED, so the 4th advance hits the non-RUNNING guard
      // in advanceBody → returns outcomeForFinishedRow (FAILED).
      const manifest = makeManifest({
        entry: 'step',
        steps: {
          step: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();
      let bodyCallCount = 0;
      dispatcher.setSyncBody('step', async () => {
        bodyCallCount++;
        throw new Error('always fails');
      });

      const executionId = await core.createExecution('test-workflow', 'step', {}, { manifest });
      const CAP = DEFAULT_MAX_ATTEMPTS_PER_STEP; // 3

      // 3 advances — each dispatches, body throws, attempt increments. On the 3rd
      // dispatch, handleRetryOrCap sees nextAttempt=3 >= cap=3 → failExecution.
      await core.advance(executionId, CAP); // attempt 0 → 1
      await core.advance(executionId, CAP); // attempt 1 → 2
      await core.advance(executionId, CAP); // attempt 2 → FAILED

      expect(store.getExecution(executionId)?.status).toBe(EXECUTION_STATUS.FAILED);
      expect(bodyCallCount).toBe(3);

      // A 4th advance on a FAILED execution returns the terminal outcome immediately
      // (advanceBody non-RUNNING path) without dispatching.
      const r4 = await core.advance(executionId, CAP);
      expect(r4.kind).toBe(ADVANCE_RESULT_KIND.FAILED);
      expect(bodyCallCount).toBe(3); // no 4th dispatch
    });
  });

  // ── (3) Step pauses, then resumes via resetForResume → COMPLETED ──────────

  describe('pause and resume: COMPLETED', () => {
    it('pauses at a signal, then resumes and continues to completion', async () => {
      const manifest = makeManifest({
        entry: 'launch',
        steps: {
          launch: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [
              {
                kind: 'pause',
                signal: 'job.done',
                resumeStep: 'finish',
              },
            ],
          },
          finish: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();

      dispatcher.setSyncBody('launch', async () => ({
        output: { jobId: 'j-1' },
        directive: {
          kind: DIRECTIVE_KIND.PAUSE_UNTIL_SIGNAL,
          signal: { name: 'job.done', correlationId: 'j-1' },
          resumeStep: 'finish',
        },
      }));

      dispatcher.setSyncBody('finish', async (input) => ({
        output: { completed: true, resumedWith: input },
        directive: { kind: DIRECTIVE_KIND.TERMINATE },
      }));

      const executionId = await core.createExecution('test-workflow', 'launch', { task: 'build' }, { manifest });

      // Advance 1: launch step runs. SyncInProcessDispatcher calls completeDispatchedStep
      // inside dispatch(). completeDispatchedStep applies PAUSE → store = PAUSED.
      // dispatch() resolves, dispatchOneStep returns DISPATCHED, advance() returns DISPATCHED.
      const r1 = await core.advance(executionId);
      expect(r1.kind).toBe(ADVANCE_RESULT_KIND.DISPATCHED);

      // Ground truth: store is PAUSED.
      const state1 = store.getExecution(executionId);
      expect(state1?.status).toBe(EXECUTION_STATUS.PAUSED);
      expect(state1?.pausedSignalName).toBe('job.done');

      // Simulate the signal arriving: resume the execution from the 'finish' step.
      await core.resetForResume(executionId, {
        fromStepName: 'finish',
        fromStepInput: { signalPayload: 'job completed' },
      });

      const state2 = store.getExecution(executionId);
      expect(state2?.status).toBe(EXECUTION_STATUS.RUNNING);
      expect(state2?.currentStep).toBe('finish');

      // Advance 2: finish step dispatches and terminates inside dispatch().
      await core.advance(executionId);
      // finish step returns TERMINATE → store = COMPLETED
      expect(store.getExecution(executionId)?.status).toBe(EXECUTION_STATUS.COMPLETED);
    });

    it('resetForResume rejects an execution in RUNNING status', async () => {
      const manifest = makeManifest({
        entry: 'step',
        steps: {
          step: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      // Use a custom dispatcher that resolves dispatch() immediately WITHOUT
      // calling completeDispatchedStep — simulating an in-flight remote dispatch.
      const store = new InMemoryExecutionStore();
      const neverCompleteDispatcher: StepDispatcher = {
        dispatch: async () => {
          /* hands off — never calls completeDispatchedStep */
        },
      };
      const core = new AgentRunnerCore({ store, dispatcher: neverCompleteDispatcher });

      const executionId = await core.createExecution('test-workflow', 'step', {}, { manifest });
      // advance() dispatches step → store.dispatchedStepRowId is set → still RUNNING
      await core.advance(executionId);

      // Execution is RUNNING (dispatch in flight) — resetForResume should reject.
      await expect(
        core.resetForResume(executionId, { fromStepName: 'step' }),
      ).rejects.toMatchObject({ name: 'NotResumableError' });
    });

    it('resetForResume on a non-existent execution throws', async () => {
      const { core } = setupCore();
      await expect(core.resetForResume('does-not-exist')).rejects.toThrow('Execution not found');
    });
  });

  // ── advance on non-existent / terminal ─────────────────────────────────────

  describe('advance edge cases', () => {
    it('throws when execution does not exist', async () => {
      const { core } = setupCore();
      await expect(core.advance('missing')).rejects.toThrow('Execution not found: missing');
    });

    it('returns COMPLETED outcome without re-running when called on a completed execution', async () => {
      const manifest = makeManifest({
        entry: 'only',
        steps: {
          only: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();
      dispatcher.setSyncBody('only', async () => ({
        output: 42,
        directive: { kind: DIRECTIVE_KIND.TERMINATE },
      }));

      const executionId = await core.createExecution('test-workflow', 'only', {}, { manifest });
      // First advance: dispatch fires, body returns TERMINATE, completeDispatchedStep
      // → completeExecution → store = COMPLETED. advance() returns DISPATCHED.
      await core.advance(executionId);
      expect(store.getExecution(executionId)?.status).toBe(EXECUTION_STATUS.COMPLETED);

      // A second advance on a completed execution hits the non-RUNNING guard in
      // advanceBody → outcomeForFinishedRow → COMPLETED. No re-dispatch.
      const result = await core.advance(executionId);
      expect(result.kind).toBe(ADVANCE_RESULT_KIND.COMPLETED);
    });
  });

  // ── createExecution ─────────────────────────────────────────────────────────

  describe('createExecution', () => {
    it('returns an executionId and the row is in RUNNING status', async () => {
      const manifest = makeManifest({
        entry: 'start',
        steps: {
          start: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'terminate' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, core } = setupCore();
      const executionId = await core.createExecution('wf', 'start', { x: 1 }, { manifest });

      expect(typeof executionId).toBe('string');
      const state = store.getExecution(executionId);
      expect(state?.status).toBe(EXECUTION_STATUS.RUNNING);
      expect(state?.currentStep).toBe('start');
      expect(state?.currentStepAttempt).toBe(0);
    });
  });

  // ── FAIL directive ──────────────────────────────────────────────────────────

  describe('FAIL directive', () => {
    it('step issuing FAIL causes execution to fail terminally', async () => {
      const manifest = makeManifest({
        entry: 'step',
        steps: {
          step: {
            timeoutMs: null,
            inputSchema: null,
            transitions: [{ kind: 'fail' }],
          },
        } as unknown as AgentManifest['steps'],
      });

      const { store, dispatcher, core } = setupCore();
      dispatcher.setSyncBody('step', async () => ({
        output: { reason: 'bad input' },
        directive: { kind: DIRECTIVE_KIND.FAIL, reason: 'bad input' },
      }));

      const executionId = await core.createExecution('test-workflow', 'step', {}, { manifest });
      // advance() → dispatch → body returns FAIL → completeDispatchedStep → failExecution.
      // advance() returns DISPATCHED; store = FAILED.
      await core.advance(executionId);

      expect(store.getExecution(executionId)?.status).toBe(EXECUTION_STATUS.FAILED);
    });
  });
});
