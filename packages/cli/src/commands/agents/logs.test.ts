/**
 * Tests for the `--follow` machinery in `logs.ts`: the {@link LiveRenderer}
 * in-place/append behavior (including wrapped-row counting), the
 * {@link followExecution} SSE → terminal / SSE-drop → poll-fallback / abort
 * paths, and the `noEvents` seam that drops `waitForExecution` to its poll loop.
 *
 * All networked calls are injected via `FollowOverrides`, so nothing here touches
 * a real gateway; abort is driven through an injected `AbortSignal` rather than a
 * real process signal.
 */
import { waitForExecution, type GatewayClient, type ExecutionProjection, type SseEvent } from '@sapiom/agent-core';

import { followExecution, LiveRenderer, noEvents } from './logs.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeExecution(status: string, id = 'exec-1'): ExecutionProjection {
  return {
    id,
    name: 'run',
    organizationId: null,
    tenantId: null,
    status,
    currentStep: null,
    currentStepAttempt: 1,
    version: 1,
    definitionId: null,
    buildRunId: null,
    idempotencyKey: null,
    pausedSignalName: null,
    pausedSignalCorrelationId: null,
    pausedUntil: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    input: null,
    sharedState: {},
    output: null,
    error: null,
    pausedStepInputSchema: null,
    pausedStepInputExample: null,
    traceRoot: id,
    rootExecutionId: id,
    traceParent: null,
    parentExecutionId: null,
    traceId: null,
    children: [],
    cost: null,
    steps: [],
  };
}

const EV: SseEvent = { type: 'step.started', executionId: 'exec-1', traceRoot: 't1', nodeId: 's1' };

/** A capturing, non-TTY renderer plus a helper to count how many human renders
 *  happened (each tree render emits exactly one `●` root line). */
function capturingRenderer(): { renderer: LiveRenderer; renderCount: () => number; output: () => string } {
  const chunks: string[] = [];
  const renderer = new LiveRenderer(false, (s) => chunks.push(s));
  return {
    renderer,
    output: () => chunks.join(''),
    renderCount: () => (chunks.join('').match(/●/g) ?? []).length,
  };
}

/** A fake SSE source yielding `events` in order; `hooks[n]` runs synchronously at
 *  the start of the n-th `next()` call (1-indexed) — used to fire an abort. */
function fakeWatch(events: SseEvent[], hooks: Record<number, () => void> = {}) {
  return () => {
    let i = 0;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<SseEvent, undefined>> {
        const call = ++i;
        hooks[call]?.();
        if (i <= events.length) return { value: events[i - 1], done: false };
        return { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<SseEvent, undefined>> {
        return { value: undefined, done: true };
      },
    };
  };
}

/** A fake SSE source whose first read throws — models a dropped/failed stream. */
function throwingWatch(message: string) {
  return () => ({
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<SseEvent, undefined>> {
      throw new Error(message);
    },
    async return(): Promise<IteratorResult<SseEvent, undefined>> {
      return { value: undefined, done: true };
    },
  });
}

/** A fake `inspect` that returns each queued projection in turn (repeating the last). */
function fakeInspect(sequence: ExecutionProjection[]) {
  let i = 0;
  return async () => sequence[Math.min(i++, sequence.length - 1)];
}

const NOOP_RENDER_OPTS = {};
const FAKE_CLIENT = {} as GatewayClient;
const sigintBaseline = () => process.listenerCount('SIGINT');

// ── LiveRenderer ──────────────────────────────────────────────────────────────

describe('LiveRenderer', () => {
  it('appends snapshots separated by a blank line when not a TTY', () => {
    const chunks: string[] = [];
    const r = new LiveRenderer(false, (s) => chunks.push(s));
    r.render(['a']);
    r.render(['b']);
    expect(chunks.join('')).toBe('a\n\nb\n');
  });

  it('clears the previous render in place on a TTY (no wrap)', () => {
    const chunks: string[] = [];
    const r = new LiveRenderer(true, (s) => chunks.push(s), () => 80);
    r.render(['x', 'y']); // two rows
    r.render(['z']);
    // Second render moves up over the two prior rows and clears to end of screen.
    expect(chunks[1]).toBe('\x1b[2A\x1b[0J');
    expect(chunks[2]).toBe('z\n');
  });

  it('counts wrapped rows so narrow terminals redraw without corruption', () => {
    const chunks: string[] = [];
    const cols = 10;
    const r = new LiveRenderer(true, (s) => chunks.push(s), () => cols);
    r.render(['0123456789012']); // width 13 → ceil(13/10) = 2 physical rows
    r.render(['short']);
    expect(chunks[1]).toBe('\x1b[2A\x1b[0J'); // moves up 2, not 1
  });
});

// ── followExecution ─────────────────────────────────────────────────────────

describe('followExecution', () => {
  it('renders once and returns when the run is already terminal', async () => {
    const { renderer, renderCount } = capturingRenderer();
    const watchSpy = jest.fn(fakeWatch([]));
    const waitSpy = jest.fn(async () => ({ execution: makeExecution('completed'), reason: 'terminal' as const, done: true }));

    await followExecution('exec-1', FAKE_CLIENT, NOOP_RENDER_OPTS, {
      inspect: fakeInspect([makeExecution('completed')]),
      watchExecution: watchSpy,
      waitForExecution: waitSpy,
      renderer,
      jsonMode: false,
    });

    expect(renderCount()).toBe(1);
    expect(watchSpy).not.toHaveBeenCalled();
    expect(waitSpy).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline());
  });

  it('re-renders on each SSE event and stops at the terminal status', async () => {
    const { renderer, renderCount } = capturingRenderer();
    const waitSpy = jest.fn(async () => ({ execution: makeExecution('completed'), reason: 'terminal' as const, done: true }));

    await followExecution('exec-1', FAKE_CLIENT, NOOP_RENDER_OPTS, {
      // initial → running, after ev1 → running, after ev2 → completed
      inspect: fakeInspect([makeExecution('running'), makeExecution('running'), makeExecution('completed')]),
      watchExecution: fakeWatch([EV, EV]),
      waitForExecution: waitSpy,
      renderer,
      jsonMode: false,
    });

    expect(renderCount()).toBe(3); // initial + ev1 + terminal
    expect(waitSpy).not.toHaveBeenCalled(); // never dropped to the fallback
  });

  it('degrades to the poll fallback when the SSE stream drops', async () => {
    const { renderer, renderCount } = capturingRenderer();
    const waitSpy = jest.fn(async () => ({ execution: makeExecution('completed'), reason: 'terminal' as const, done: true }));

    await followExecution('exec-1', FAKE_CLIENT, NOOP_RENDER_OPTS, {
      inspect: fakeInspect([makeExecution('running')]),
      watchExecution: throwingWatch('sse handshake failed'),
      waitForExecution: waitSpy,
      renderer,
      jsonMode: false,
    });

    expect(waitSpy).toHaveBeenCalledTimes(1);
    expect(renderCount()).toBe(2); // initial + final from the fallback
  });

  it('keeps polling the fallback through timeouts until terminal', async () => {
    const { renderer, renderCount } = capturingRenderer();
    const results = [
      { execution: makeExecution('running'), reason: 'timeout' as const, done: false },
      { execution: makeExecution('completed'), reason: 'terminal' as const, done: true },
    ];
    let i = 0;
    const waitSpy = jest.fn(async () => results[i++]);

    await followExecution('exec-1', FAKE_CLIENT, NOOP_RENDER_OPTS, {
      inspect: fakeInspect([makeExecution('running')]),
      watchExecution: throwingWatch('drop'),
      waitForExecution: waitSpy,
      renderer,
      jsonMode: false,
    });

    expect(waitSpy).toHaveBeenCalledTimes(2);
    expect(renderCount()).toBe(3); // initial + timeout re-render + terminal
  });

  it('tears down cleanly on abort mid-stream without touching the fallback', async () => {
    const { renderer, renderCount } = capturingRenderer();
    const abort = new AbortController();
    const waitSpy = jest.fn(async () => ({ execution: makeExecution('completed'), reason: 'terminal' as const, done: true }));

    await followExecution('exec-1', FAKE_CLIENT, NOOP_RENDER_OPTS, {
      inspect: fakeInspect([makeExecution('running'), makeExecution('running')]),
      // ev1 processed; on the 2nd next() the caller aborts (Ctrl-C analogue)
      watchExecution: fakeWatch([EV], { 2: () => abort.abort() }),
      waitForExecution: waitSpy,
      renderer,
      jsonMode: false,
      signal: abort.signal,
    });

    expect(waitSpy).not.toHaveBeenCalled(); // abort short-circuits before the fallback
    expect(renderCount()).toBeGreaterThanOrEqual(2); // initial + at least the final
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline()); // listener removed
  });
});

// ── noEvents / waitForExecution contract (#4) ───────────────────────────────

describe('noEvents drops waitForExecution to its poll loop', () => {
  it('does NOT treat the immediately-done iterator as "run finished"', async () => {
    // A client whose inspect read reports running first, then completed. If the
    // empty iterator were mistaken for completion, wait would return on the first
    // (running) read; instead it must poll and settle on the completed read.
    const bodies = [makeExecution('running'), makeExecution('completed')];
    let i = 0;
    const client = {
      get: async () => bodies[Math.min(i++, bodies.length - 1)],
    } as unknown as GatewayClient;

    const result = await waitForExecution(
      {
        executionId: 'exec-1',
        maxWaitMs: 10_000,
        watch: () => noEvents(),
        sleep: async () => {
          /* resolve immediately — no real delay in tests */
        },
        now: Date.now,
      },
      client,
    );

    expect(result.done).toBe(true);
    expect(result.reason).toBe('terminal');
    expect(result.execution.status).toBe('completed');
    expect(i).toBeGreaterThanOrEqual(2); // polled at least twice (running → completed)
  });
});
