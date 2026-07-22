/**
 * Unit tests for the pure `render` module: the execution tree, the tree-aware
 * list, and the cost formatter. These lock in the two load-bearing contracts —
 * captured/authorized cost is never collapsed, and a null cost is honest absence
 * (never a fabricated `$0`) — plus the tree shape (steps, nested child runs,
 * orphan child edges) and list grouping by `traceRoot`.
 */
import type { CostNode, ExecutionProjection, ExecutionRef, StepProjection } from '@sapiom/agent-core';

import { formatCost, renderExecutionList, renderExecutionTree } from './render.js';

function makeStep(partial: Partial<StepProjection> = {}): StepProjection {
  return {
    stepName: 'step',
    stepOrder: 0,
    attempt: 1,
    status: 'succeeded',
    spanId: null,
    startedAt: null,
    finishedAt: null,
    input: null,
    output: null,
    sharedStateAfter: null,
    nextDirective: null,
    cost: null,
    logs: null,
    events: [],
    error: null,
    dispatch: null,
    ...partial,
  };
}

function makeExecution(partial: Partial<ExecutionProjection> = {}): ExecutionProjection {
  return {
    id: 'exec-1',
    name: 'run',
    organizationId: null,
    tenantId: null,
    status: 'running',
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
    traceRoot: 'exec-1',
    rootExecutionId: 'exec-1',
    traceParent: null,
    parentExecutionId: null,
    traceId: null,
    children: [],
    cost: null,
    steps: [],
    ...partial,
  };
}

function makeRef(partial: Partial<ExecutionRef> = {}): ExecutionRef {
  return { executionId: 'ref-1', traceRoot: 'ref-1', name: '', status: 'running', ...partial };
}

const cost = (
  captured: string,
  authorized: string,
  settleState: CostNode['settleState'] = 'final',
): CostNode => ({ capturedUsd: captured, authorizedUsd: authorized, settleState });

describe('formatCost', () => {
  it('returns null on honest absence — never a fabricated $0', () => {
    expect(formatCost(null)).toBeNull();
  });

  it('keeps captured and authorized separate (never collapsed)', () => {
    expect(formatCost(cost('0.42', '1.00'))).toBe('$0.42 captured · ≤ $1.00 auth');
  });

  it('shows a present zero cost (known zero, not absence)', () => {
    expect(formatCost(cost('0', '0'))).toBe('$0 captured · ≤ $0 auth');
  });

  it('appends a settlement affordance while settling', () => {
    expect(formatCost(cost('0.10', '0.50', 'settling'))).toBe('$0.10 captured · ≤ $0.50 auth · settling…');
  });

  it('appends a pending affordance for an estimate-only node', () => {
    expect(formatCost(cost('0', '0.50', 'pending'))).toBe('$0 captured · ≤ $0.50 auth · pending');
  });
});

describe('renderExecutionTree', () => {
  it('renders the run as the root with per-node cost and each step as a branch', () => {
    const ex = makeExecution({
      id: 'exec-1',
      status: 'running',
      currentStep: 'generate',
      cost: cost('0.42', '1.00', 'settling'),
      steps: [
        makeStep({ stepName: 'plan', attempt: 1, status: 'succeeded', cost: cost('0.01', '0.01') }),
        makeStep({
          stepName: 'generate',
          stepOrder: 1,
          attempt: 2,
          status: 'running',
          cost: cost('0.41', '0.99', 'settling'),
        }),
      ],
    });

    expect(renderExecutionTree(ex)).toEqual([
      '● exec-1 — running (at generate)   $0.42 captured · ≤ $1.00 auth · settling…',
      '├─ ✓ plan #1 — succeeded   $0.01 captured · ≤ $0.01 auth',
      '└─ ▶ generate #2 — running   $0.41 captured · ≤ $0.99 auth · settling…',
    ]);
  });

  it('omits cost entirely when a node has none (honest absence)', () => {
    const ex = makeExecution({ steps: [makeStep({ stepName: 'plan', cost: null })] });
    const lines = renderExecutionTree(ex);
    expect(lines[0]).toBe('● exec-1 — running');
    expect(lines[1]).toBe('└─ ✓ plan #1 — succeeded');
    expect(lines.join('\n')).not.toContain('$');
  });

  it('shows a failed step error and nests its dispatched child run', () => {
    const ex = makeExecution({
      steps: [
        makeStep({
          stepName: 'boom',
          status: 'failed',
          error: { message: 'kaboom', trace: null, traceUnavailableReason: null },
        }),
        makeStep({
          stepName: 'dispatch',
          stepOrder: 1,
          status: 'running',
          dispatch: { childExecutionId: 'child-9', targetType: 'agent', correlationId: 'corr-1', status: 'pending' },
        }),
      ],
      children: [makeRef({ executionId: 'child-9', traceRoot: 'exec-1', name: 'deploy-preview', status: 'running' })],
    });

    expect(renderExecutionTree(ex)).toEqual([
      '● exec-1 — running',
      '├─ ✗ boom #1 — failed',
      '│  ↳ error: kaboom',
      '└─ ▶ dispatch #1 — running',
      '   └─ ▶ child-9 — running (deploy-preview)',
    ]);
  });

  it('appends child edges not reached via a step dispatch rather than dropping them', () => {
    const ex = makeExecution({
      steps: [makeStep({ stepName: 'plan' })],
      children: [makeRef({ executionId: 'orphan-1', traceRoot: 'exec-1', name: 'sub', status: 'completed' })],
    });

    expect(renderExecutionTree(ex)).toEqual([
      '● exec-1 — running',
      '├─ ✓ plan #1 — succeeded',
      '└─ ✓ orphan-1 — completed (sub)',
    ]);
  });

  it('adds timings and dispatch details in verbose mode', () => {
    const ex = makeExecution({
      steps: [
        makeStep({
          stepName: 'gen',
          status: 'running',
          startedAt: '2026-01-01T00:00:01.000Z',
          finishedAt: null,
          dispatch: { childExecutionId: 'c1', targetType: 'agent', correlationId: 'corr-x', status: 'pending' },
        }),
      ],
      children: [],
    });

    const lines = renderExecutionTree(ex, { verbose: true });
    expect(lines.some((l) => l.includes('↳ 2026-01-01T00:00:01.000Z → (running)'))).toBe(true);
    expect(lines.some((l) => l.includes('↳ dispatch agent · corr corr-x (pending)'))).toBe(true);
  });
});

describe('renderExecutionList', () => {
  it('renders an honest empty marker for no executions', () => {
    expect(renderExecutionList([])).toEqual(['(no executions)']);
  });

  it('renders standalone rows (traceRoot === own id) as top-level runs', () => {
    const refs = [
      makeRef({ executionId: 'a', traceRoot: 'a', name: 'first', status: 'completed' }),
      makeRef({ executionId: 'b', traceRoot: 'b', name: '', status: 'running' }),
    ];
    expect(renderExecutionList(refs)).toEqual(['✓ a — completed (first)', '▶ b — running']);
  });

  it('groups a dispatch tree under its root, nesting children by traceRoot', () => {
    const refs = [
      makeRef({ executionId: 'root', traceRoot: 'root', name: 'parent', status: 'running' }),
      makeRef({ executionId: 'kid', traceRoot: 'root', name: 'child', status: 'completed' }),
    ];
    expect(renderExecutionList(refs)).toEqual(['▶ root — running (parent)', '└─ ✓ kid — completed (child)']);
  });

  it('synthesizes a root when only children reference a traceRoot', () => {
    const refs = [makeRef({ executionId: 'kid', traceRoot: 'ghost-root', name: 'child', status: 'running' })];
    expect(renderExecutionList(refs)).toEqual(['· ghost-root — (root)', '└─ ▶ kid — running (child)']);
  });
});
