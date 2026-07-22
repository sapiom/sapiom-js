/**
 * Pure renderers for the `sapiom agents logs` human output: an
 * {@link ExecutionProjection} as a tree (steps + dispatched child runs, per-node
 * cost) and a `listExecutions()` result as a tree-aware {@link ExecutionRef}
 * grouping. Pure and deterministic — no I/O, no clock — so the same functions
 * drive the one-shot render and the `--follow` re-render, and are snapshot-tested
 * directly.
 *
 * Two contracts are load-bearing here and match the SDK projection semantics:
 *   - Cost NEVER collapses `capturedUsd` (settled) and `authorizedUsd` (the
 *     hold / ceiling) into a single number — both are always shown side by side.
 *   - A `null` cost is honest absence (the execution-detail read is cost-agnostic
 *     today) and renders as NOTHING — never a fabricated `$0`. A present cost of
 *     `"0"` is a known zero and IS shown.
 */
import type { CostNode, DispatchRef, ExecutionProjection, ExecutionRef, StepProjection } from '@sapiom/agent-core';

/** Render toggles. Compact (default) shows one line per node plus any error;
 *  verbose adds timings and dispatch details. */
export interface RenderOptions {
  verbose?: boolean;
}

/**
 * Status → glyph, folding the real engine vocabulary the projection carries
 * (`succeeded`/`threw` from the agents surface) plus the earlier
 * `completed`/`failed`/`cancelled` values. Anything not yet running/passed/failed
 * (queued, unknown, pending) is the neutral `·` — mirrors the harness renderer's
 * status fold so the CLI and canvas never disagree on what a status means.
 */
function statusGlyph(status: string): string {
  if (status === 'succeeded' || status === 'completed') return '✓';
  if (status === 'failed' || status === 'threw' || status === 'cancelled' || status === 'canceled') return '✗';
  if (status === 'running') return '▶';
  return '·';
}

/**
 * Format a per-node cost, keeping captured and authorized separate (never
 * collapsed) and appending a settlement affordance while a node is still
 * settling. Returns `null` for honest absence (a null cost) so callers append
 * nothing — never a fabricated `$0`.
 */
export function formatCost(cost: CostNode | null): string | null {
  if (!cost) return null;
  const settle =
    cost.settleState === 'settling' ? ' · settling…' : cost.settleState === 'pending' ? ' · pending' : '';
  return `$${cost.capturedUsd} captured · ≤ $${cost.authorizedUsd} auth${settle}`;
}

/** Append a formatted cost to a headline, or leave it untouched on honest absence. */
function withCost(base: string, cost: CostNode | null): string {
  const c = formatCost(cost);
  return c ? `${base}   ${c}` : base;
}

/** A node in the render tree: a headline, optional detail sub-lines (error,
 *  timings), and nested children (dispatched child runs). */
interface TreeNode {
  headline: string;
  sublines: string[];
  children: TreeNode[];
}

/**
 * Emit `children` under `prefix` with box-drawing connectors, recursing into
 * each node's own children. The last child uses `└─` (and blank continuation);
 * every other uses `├─` (and a `│` continuation) so vertical guides line up.
 */
function pushChildren(children: TreeNode[], prefix: string, lines: string[]): void {
  children.forEach((child, i) => {
    const last = i === children.length - 1;
    const branch = last ? '└─ ' : '├─ ';
    const cont = last ? '   ' : '│  ';
    lines.push(prefix + branch + child.headline);
    for (const sub of child.sublines) lines.push(prefix + cont + sub);
    pushChildren(child.children, prefix + cont, lines);
  });
}

/** Headline for a step-attempt node. */
function stepHeadline(step: StepProjection): string {
  const base = `${statusGlyph(step.status)} ${step.stepName} #${step.attempt} — ${step.status}`;
  return withCost(base, step.cost);
}

/** Detail sub-lines for a step: its error (always) and, when verbose, timings
 *  and the dispatch edge. Cost/settleState already ride on the headline. */
function stepSublines(step: StepProjection, opts: RenderOptions): string[] {
  const out: string[] = [];
  if (step.error?.message) out.push(`↳ error: ${step.error.message}`);
  if (opts.verbose) {
    if (step.startedAt) {
      out.push(`↳ ${step.startedAt} → ${step.finishedAt ?? '(running)'}`);
    }
    if (step.dispatch) {
      out.push(`↳ dispatch ${step.dispatch.targetType} · corr ${step.dispatch.correlationId} (${step.dispatch.status})`);
    }
    if (step.error && !step.error.trace && step.error.traceUnavailableReason) {
      out.push(`↳ trace: ${step.error.traceUnavailableReason}`);
    }
  }
  return out;
}

/** Leaf node for a dispatched child run. Prefers the typed {@link ExecutionRef}
 *  edge (carries name + status); falls back to the {@link DispatchRef} when the
 *  child edge is absent, degrading honestly rather than fabricating a name. */
function childNode(ref: ExecutionRef | undefined, dispatch: DispatchRef): TreeNode {
  if (ref) {
    const name = ref.name ? ` (${ref.name})` : '';
    return {
      headline: `${statusGlyph(ref.status)} ${ref.executionId} — ${ref.status}${name}`,
      sublines: [],
      children: [],
    };
  }
  return {
    headline: `${statusGlyph(dispatch.status)} ${dispatch.childExecutionId} — ${dispatch.status} (${dispatch.targetType})`,
    sublines: [],
    children: [],
  };
}

/** Leaf node for an {@link ExecutionRef} (a child edge or a list row). */
function refNode(ref: ExecutionRef): TreeNode {
  const name = ref.name ? ` (${ref.name})` : '';
  return {
    headline: `${statusGlyph(ref.status)} ${ref.executionId} — ${ref.status}${name}`,
    sublines: [],
    children: [],
  };
}

/**
 * Render one {@link ExecutionProjection} as a tree: the run as the root, its
 * steps as branches (ordered as the projection delivers them), and each step's
 * dispatched child run nested beneath it. Any child edge in `children` not
 * reached through a step's dispatch is appended under the run so no child is
 * ever silently dropped. Per-node cost rides on every headline that has one.
 */
export function renderExecutionTree(ex: ExecutionProjection, opts: RenderOptions = {}): string[] {
  const root = withCost(`● ${ex.id} — ${ex.status}${ex.currentStep ? ` (at ${ex.currentStep})` : ''}`, ex.cost);
  const lines = [root];

  const shownChildIds = new Set<string>();
  const stepNodes: TreeNode[] = ex.steps.map((step) => {
    const node: TreeNode = { headline: stepHeadline(step), sublines: stepSublines(step, opts), children: [] };
    if (step.dispatch) {
      const ref = ex.children.find((c) => c.executionId === step.dispatch!.childExecutionId);
      node.children.push(childNode(ref, step.dispatch));
      shownChildIds.add(step.dispatch.childExecutionId);
    }
    return node;
  });

  // Child edges not reached via a step dispatch (e.g. dispatch not yet populated)
  // still belong to the tree — append them under the run rather than lose them.
  const orphans = ex.children.filter((c) => !shownChildIds.has(c.executionId)).map(refNode);

  pushChildren([...stepNodes, ...orphans], '', lines);
  return lines;
}

/**
 * Render a `listExecutions()` result as a tree-aware view: rows are grouped by
 * `traceRoot` (first-seen order preserved) so a dispatch tree renders as a root
 * with its children nested. Per the SDK's documented server-side gap most list
 * rows degrade `traceRoot` to their own id, so they render as standalone
 * top-level runs — honest, not a fabricated hierarchy.
 */
export function renderExecutionList(refs: ExecutionRef[]): string[] {
  if (refs.length === 0) return ['(no executions)'];

  const order: string[] = [];
  const groups = new Map<string, ExecutionRef[]>();
  for (const r of refs) {
    const root = r.traceRoot || r.executionId;
    if (!groups.has(root)) {
      groups.set(root, []);
      order.push(root);
    }
    groups.get(root)!.push(r);
  }

  const lines: string[] = [];
  for (const rootId of order) {
    const group = groups.get(rootId)!;
    const rootRef = group.find((r) => r.executionId === rootId);
    const children = group.filter((r) => r.executionId !== rootId);
    lines.push(rootRef ? refNode(rootRef).headline : `· ${rootId} — (root)`);
    pushChildren(children.map(refNode), '', lines);
  }
  return lines;
}
