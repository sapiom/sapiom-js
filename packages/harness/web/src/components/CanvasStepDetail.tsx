import type { JSX } from "react";
import type { RunView, StepView, WorkflowInfo } from "@shared/types";

import type { CanvasGraph, CanvasGraphEdge, CanvasGraphNode } from "../lib/canvas-graph";
import { formatTimeout, stepFacts, stepInputFields } from "../lib/canvas-graph";
import { formatPayload } from "../lib/format-payload";
import { formatCostExact, runSummaryLabel } from "../lib/run-cost";
import type { RunTarget } from "../lib/use-harness-state";
import { Icon } from "./Icon";

/** RunView steps are keyed by the manifest step name == our node id. */
export function runStepFor(run: RunView | null, nodeId: string): StepView | null {
  return run?.steps.find((s) => s.name === nodeId) ?? null;
}

/** Status glyph for a run step: check, cross, pulse, or hollow pending dot.
 *  Purely additive - without a run the structural kind dot renders instead. */
function StepStatusIcon({ status }: { status: StepView["status"] }): JSX.Element {
  if (status === "passed") {
    return (
      <span className="canvas-run-status is-passed" data-status="passed" aria-label="passed">
        <Icon name="Check" size={11} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="canvas-run-status is-failed" data-status="failed" aria-label="failed">
        <Icon name="X" size={11} />
      </span>
    );
  }
  if (status === "running") {
    return <span className="canvas-run-status is-running" data-status="running" aria-label="running" />;
  }
  return <span className="canvas-run-status is-pending" data-status="pending" aria-label="pending" />;
}

/** Non-sequential edges carry meaning worth surfacing (branch/pause/launch). */
function edgeKindLabel(edge: CanvasGraphEdge): string | null {
  if (edge.kind === "branching") return "branch";
  if (edge.kind === "cross") return "pause resume";
  if (edge.kind === "launch") return "launch";
  return null;
}

/** The step's declared input contract as compact field chips — real schema
 *  fields only; steps without a declared schema render nothing. */
function StepInputContract({ node }: { node: CanvasGraphNode }): JSX.Element | null {
  const fields = stepInputFields(node);
  if (fields.length === 0) return null;
  return (
    <div className="canvas-input-card" data-testid={`canvas-step-input-${node.id}`}>
      <span className="canvas-input-label">Input</span>
      <span className="canvas-input-fields">
        {fields.map((f) => (
          <code
            key={f.name}
            className={"canvas-input-field" + (f.required ? " is-required" : "")}
            aria-label={`${f.name}, ${f.type}${f.required ? ", required" : ""}`}
          >
            {f.name}
            {f.required && <span aria-hidden="true">*</span>}
            <span className="canvas-input-type">{f.type}</span>
          </code>
        ))}
      </span>
    </div>
  );
}

/** The step's Sapiom capabilities as chips — real extraction only; steps
 *  without declared capabilities render nothing. */
function StepCapabilities({ node }: { node: CanvasGraphNode }): JSX.Element | null {
  if (node.capabilities.length === 0) return null;
  return (
    <div className="canvas-input-card" data-testid={`canvas-step-capabilities-${node.id}`}>
      <span className="canvas-input-label">Capabilities</span>
      <span className="canvas-input-fields">
        {node.capabilities.map((capability) => (
          <code
            key={capability}
            className="canvas-input-field"
            data-tooltip="Sapiom capability this step calls"
          >
            {capability}
          </code>
        ))}
      </span>
    </div>
  );
}

/**
 * A step's real transitions as compact elbow rows — what it leads to
 * (CornerDownRight, with branch condition / pause signal) and what reaches
 * it (CornerLeftUp). Shared by the steps accordion and the board's bottom
 * inspector; with `onSelectStep` the rows become links that retarget the
 * selection, without it they stay plain information.
 */
export function StepTransitions({
  graph,
  node,
  onSelectStep,
}: {
  graph: CanvasGraph;
  node: CanvasGraphNode;
  onSelectStep?: (id: string) => void;
}): JSX.Element | null {
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const incoming = graph.edges.filter((e) => e.to === node.id);
  if (outgoing.length === 0 && incoming.length === 0) return null;
  const labelFor = (id: string): string => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const row = (edge: CanvasGraphEdge, target: string, icon: "CornerDownRight" | "CornerLeftUp"): JSX.Element => {
    const body = (
      <>
        <Icon name={icon} size={12} />
        <span className="canvas-step-transition-target">{labelFor(target)}</span>
        {edge.label && <span className="canvas-step-transition-cond">{edge.label}</span>}
      </>
    );
    const key = `${icon}${edge.from}->${edge.to}`;
    return onSelectStep ? (
      <button
        key={key}
        className="canvas-step-transition is-link"
        data-tooltip={`Inspect ${labelFor(target)}`}
        onClick={() => onSelectStep(target)}
      >
        {body}
      </button>
    ) : (
      <div key={key} className="canvas-step-transition">
        {body}
      </div>
    );
  };
  return (
    <>
      {outgoing.map((e) => row(e, e.to, "CornerDownRight"))}
      {incoming.map((e) => row(e, e.from, "CornerLeftUp"))}
    </>
  );
}

/** The workflow a launched-workflow node points at, when the registry knows
 *  it — matched by path, name, or path basename against the node label. */
function launchedWorkflowFor(node: CanvasGraphNode, workflows: WorkflowInfo[]): WorkflowInfo | null {
  if (node.kind !== "launched-workflow") return null;
  return (
    workflows.find((w) => w.path === node.label) ??
    workflows.find((w) => w.name === node.label) ??
    workflows.find((w) => w.path.endsWith(`/${node.label}`)) ??
    null
  );
}

/** Cross-workflow navigation for a launched-workflow node: one click binds
 *  and switches to the launched workflow instead of a dead-end text chip. */
function OpenLaunchedWorkflow({
  node,
  workflows,
  onOpenWorkflow,
}: {
  node: CanvasGraphNode;
  workflows: WorkflowInfo[];
  onOpenWorkflow: (path: string) => void;
}): JSX.Element | null {
  const launched = launchedWorkflowFor(node, workflows);
  if (!launched) return null;
  return (
    <button
      className="canvas-step-open"
      data-testid={`canvas-open-workflow-${node.id}`}
      data-tooltip={`Switch to ${launched.name}`}
      onClick={() => onOpenWorkflow(launched.path)}
    >
      Open workflow <Icon name="ArrowRight" size={12} />
    </button>
  );
}

/**
 * Run-only steps view: when a run has been observed but the canvas
 * has not posted a structural graph (nothing visualized, or a document
 * without the graph contract), the real per-step data still renders —
 * name, status, latency, cost, error, logs — instead of "No steps yet".
 * Structure (transitions, contracts) needs Visualize; the hint says so.
 */
export function RunStepsList({ run, target }: { run: RunView; target: RunTarget | null }): JSX.Element {
  return (
    <div className="canvas-steps-list" data-testid="canvas-run-fallback">
      <div className="canvas-steps-label">
        Run steps
        <span className="canvas-steps-run-note" data-testid="canvas-steps-run-note">
          {runSummaryLabel(run, target)}
        </span>
      </div>
      {run.steps.map((step, index) => {
        const meta = [
          step.latencyMs !== undefined ? formatTimeout(step.latencyMs) : null,
          step.costUsd !== undefined ? formatCostExact(step.costUsd) : null,
        ].filter((v): v is string => v !== null);
        return (
          <div key={step.id} className="canvas-step-item">
            <div className="canvas-step-row is-static" data-testid={`canvas-run-step-${step.name}`}>
              <span className="canvas-step-index">{String(index + 1).padStart(2, "0")}</span>
              <StepStatusIcon status={step.status} />
              <span className="canvas-step-copy">
                <span className="canvas-step-name">{step.name}</span>
                <span className="canvas-step-role">{step.status}</span>
              </span>
              <span className="canvas-step-meta">{meta.join(" · ")}</span>
              <span aria-hidden="true" />
            </div>
            {(step.error || step.logSlice) && (
              <div className="canvas-step-expand">
                {step.error && <pre className="canvas-run-error">{step.error}</pre>}
                {step.logSlice && (
                  <details className="canvas-run-logs">
                    <summary>Logs</summary>
                    <pre>{step.logSlice}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="canvas-empty-hint">
        Run data only. Visualize on the Canvas tab to map transitions and contracts.
      </p>
    </div>
  );
}

/**
 * Accordion steps list for the overview sheet: a row EXPANDS in place
 * (chevron rotates — real collapse/expand semantics, matching what the row
 * looks like it does), showing the step's description, input contract, and
 * transitions as plain information. Navigation to the full-pane detail is a
 * separate, explicit affordance inside the expansion.
 *
 * Row anatomy (index | kind dot | name + role eyebrow | facts | caret)
 * carries manifest truth; when a run has been observed (execution.started ->
 * polled RunView) the dot becomes the step's run status and the meta column
 * shows its real latency/cost. Absent run fields stay absent - no zeros, no
 * placeholder columns.
 */
export function CanvasStepsList({
  graph,
  run,
  runTarget,
  workflows,
  onOpenWorkflow,
  expandedId,
  onToggle,
  onOpenDetail,
}: {
  graph: CanvasGraph;
  /** The session's shown run; per-step status/latency/cost render only
   *  when present - structure-only lists carry no run columns at all. */
  run: RunView | null;
  /** Where that run executed (prod = billed, local = free); null when the
   *  bus message predates the target field. */
  runTarget: RunTarget | null;
  /** Registry workflows — launched-workflow nodes link through to theirs. */
  workflows: WorkflowInfo[];
  onOpenWorkflow: (path: string) => void;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onOpenDetail: (id: string) => void;
}): JSX.Element {
  // Same validity rule as the board's group bands: a group referencing a
  // step that no longer exists is stale enrichment and renders nowhere, so
  // list and board never contradict each other.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const validGroups = graph.groups.filter((g) => g.nodeIds.length > 0 && g.nodeIds.every((id) => nodeIds.has(id)));
  const groupFor = (id: string): string | null =>
    validGroups.find((g) => g.nodeIds.includes(id))?.label ?? null;
  // Contiguous runs of the same group render as one bounded band; ungrouped
  // runs render flat. This is the list projection of the board's bands.
  const segments: { group: string | null; nodes: { node: (typeof graph.nodes)[number]; index: number }[] }[] = [];
  graph.nodes.forEach((node, index) => {
    const group = groupFor(node.id);
    const last = segments[segments.length - 1];
    if (last && last.group === group) last.nodes.push({ node, index });
    else segments.push({ group, nodes: [{ node, index }] });
  });
  return (
    <div className="canvas-steps-list" data-testid="canvas-steps-list">
      <div className="canvas-steps-label">
        Steps
        {/* The run's origin and total cost lead the list —
            "did this cost me anything" answered before any row is read. */}
        {run && (
          <span className="canvas-steps-run-note" data-testid="canvas-steps-run-note">
            {runSummaryLabel(run, runTarget)}
          </span>
        )}
      </div>
      {segments.map((segment, segIndex) => (
        <div
          key={`${segment.group ?? "ungrouped"}-${segIndex}`}
          className={segment.group ? "canvas-step-band" : undefined}
        >
          {segment.group && <div className="canvas-step-group">{segment.group}</div>}
          {segment.nodes.map(({ node, index }) => {
        const open = expandedId === node.id;
        const facts = stepFacts(node, graph.edges);
        const runStep = runStepFor(run, node.id);
        // Run truth leads the meta column when it exists; structure facts
        // otherwise. Absent fields stay absent (no fabricated zeros).
        const runMeta = runStep
          ? [
              runStep.latencyMs !== undefined ? formatTimeout(runStep.latencyMs) : null,
              runStep.costUsd !== undefined ? formatCostExact(runStep.costUsd) : null,
            ].filter((v): v is string => v !== null)
          : [];
        return (
          <div key={node.id} className={"canvas-step-item" + (open ? " is-open" : "")}>
            <button
              className="canvas-step-row"
              data-testid={`canvas-step-row-${node.id}`}
              aria-expanded={open}
              onClick={() => onToggle(node.id)}
            >
              <span className="canvas-step-index">{String(index + 1).padStart(2, "0")}</span>
              {runStep ? (
                <StepStatusIcon status={runStep.status} />
              ) : (
                <span className={"canvas-step-dot dot--" + node.kind} aria-hidden="true" />
              )}
              <span className="canvas-step-copy">
                <span className="canvas-step-name">{node.label}</span>
                <span className="canvas-step-role">{node.role}</span>
              </span>
              <span className="canvas-step-meta">{(runMeta.length > 0 ? runMeta : facts).join(" · ")}</span>
              {/* Disclosure caret contract: down when closed, rotated 180 to
                  up when open. Right-pointing chevrons/arrows are reserved
                  for navigation rows (Full details, Open workflow). */}
              <span className={"canvas-step-caret" + (open ? " is-open" : "")} aria-hidden="true">
                <Icon name="ChevronDown" size={13} />
              </span>
            </button>
            {open && (
              <div className="canvas-step-expand" data-testid={`canvas-step-expand-${node.id}`}>
                {node.description && <p className="canvas-step-desc">{node.description}</p>}
                <StepInputContract node={node} />
                <StepCapabilities node={node} />
                <StepTransitions graph={graph} node={node} />
                <OpenLaunchedWorkflow node={node} workflows={workflows} onOpenWorkflow={onOpenWorkflow} />
                <button
                  className="canvas-step-open"
                  data-testid={`canvas-step-open-${node.id}`}
                  onClick={() => onOpenDetail(node.id)}
                >
                  Full details <Icon name="ArrowRight" size={12} />
                </button>
              </div>
            )}
          </div>
        );
      })}
        </div>
      ))}
    </div>
  );
}

interface CanvasStepDetailProps {
  graph: CanvasGraph;
  node: CanvasGraphNode;
  /** The session's shown run, if any (see CanvasStepsList). */
  run: RunView | null;
  /** Jump to another step's detail (from a transition row). */
  onSelectStep: (id: string) => void;
  /** Registry workflows — launched-workflow nodes link through to theirs. */
  workflows: WorkflowInfo[];
  onOpenWorkflow: (path: string) => void;
}

/**
 * Per-step drill-down BODY (its chrome — back, name, kind, actions — lives
 * in the canvas subheader; see WorkflowActionsHeader). Driven entirely by
 * the posted graph: the step's role and description, then its real
 * transitions — what it leads to (with branch condition / pause signal) and
 * what reaches it. Each transition links deeper into the graph.
 */
export function CanvasStepDetail({
  graph,
  node,
  run,
  onSelectStep,
  workflows,
  onOpenWorkflow,
}: CanvasStepDetailProps): JSX.Element {
  const runStep = runStepFor(run, node.id);
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const incoming = graph.edges.filter((e) => e.to === node.id);
  const labelFor = (id: string): string => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const groups = graph.groups.filter((g) => g.nodeIds.includes(node.id));

  return (
    <div className="canvas-detail" data-testid="canvas-step-detail">
      <div className="canvas-detail-body">
        {node.role && <p className="canvas-detail-role">{node.role}</p>}
        {node.description && <p className="canvas-detail-desc">{node.description}</p>}
        {groups.length > 0 && (
          <p className="canvas-detail-groups">
            Part of {groups.map((g) => g.label).join(", ")}
          </p>
        )}
        <OpenLaunchedWorkflow node={node} workflows={workflows} onOpenWorkflow={onOpenWorkflow} />

        {runStep && (
          <section className="canvas-detail-section" data-testid="canvas-detail-run">
            <h4>Last run</h4>
            <div className="canvas-detail-contract">
              <span className="canvas-input-label">Status</span>
              <span className={"canvas-run-text is-" + runStep.status}>
                <StepStatusIcon status={runStep.status} />
                {runStep.status}
              </span>
            </div>
            {runStep.latencyMs !== undefined && (
              <div className="canvas-detail-contract">
                <span className="canvas-input-label">Duration</span>
                <span className="canvas-detail-timeout">{formatTimeout(runStep.latencyMs)}</span>
              </div>
            )}
            {runStep.costUsd !== undefined && (
              <div className="canvas-detail-contract">
                <span className="canvas-input-label">Cost</span>
                <span className="canvas-detail-timeout">{formatCostExact(runStep.costUsd)}</span>
              </div>
            )}
            {/* Real per-step IO — the value this step actually ran on and what
                it produced. Gated on `!== undefined` (not truthiness) so an
                honest `null`/`false`/`0`/`""` still renders; a step that never
                carried an input/output shows no block at all (no fabrication).
                Capability, not model: these are the step's own payloads, with
                no provider/model surfaced anywhere. */}
            {runStep.input !== undefined && (
              <details className="canvas-run-logs" data-testid={`canvas-detail-run-input-${node.id}`}>
                <summary>Input</summary>
                <pre>{formatPayload(runStep.input)}</pre>
              </details>
            )}
            {runStep.output !== undefined && (
              <details className="canvas-run-logs" data-testid={`canvas-detail-run-output-${node.id}`}>
                <summary>Output</summary>
                <pre>{formatPayload(runStep.output)}</pre>
              </details>
            )}
            {runStep.error && <pre className="canvas-run-error">{runStep.error}</pre>}
            {runStep.logSlice && (
              <details className="canvas-run-logs">
                <summary>Logs</summary>
                <pre>{runStep.logSlice}</pre>
              </details>
            )}
          </section>
        )}

        {(stepInputFields(node).length > 0 || node.timeoutMs !== null || node.capabilities.length > 0) && (
          <section className="canvas-detail-section">
            <h4>Contract</h4>
            {node.capabilities.length > 0 && (
              <div className="canvas-detail-contract" data-testid="canvas-detail-capabilities">
                <span className="canvas-input-label">Capabilities</span>
                <span className="canvas-input-fields">
                  {node.capabilities.map((capability) => (
                    <code
                      key={capability}
                      className="canvas-input-field"
                      data-tooltip="Sapiom capability this step calls"
                    >
                      {capability}
                    </code>
                  ))}
                </span>
              </div>
            )}
            {stepInputFields(node).length > 0 && (
              <div className="canvas-detail-contract" data-testid="canvas-detail-input">
                <span className="canvas-input-label">Input</span>
                <span className="canvas-input-fields">
                  {stepInputFields(node).map((f) => (
                    <code
                      key={f.name}
                      className={"canvas-input-field" + (f.required ? " is-required" : "")}
                      aria-label={`${f.name}, ${f.type}${f.required ? ", required" : ""}`}
                      data-tooltip={f.required ? "Required field" : "Optional field"}
                    >
                      {f.name}
                      {f.required && <span aria-hidden="true">*</span>}
                      <span className="canvas-input-type">{f.type}</span>
                    </code>
                  ))}
                </span>
              </div>
            )}
            {node.timeoutMs !== null && (
              <div className="canvas-detail-contract">
                <span className="canvas-input-label">Timeout</span>
                <span className="canvas-detail-timeout">{formatTimeout(node.timeoutMs)}</span>
              </div>
            )}
          </section>
        )}

        <section className="canvas-detail-section">
          <h4>
            Leads to <span className="canvas-detail-count">{outgoing.length}</span>
          </h4>
          {outgoing.length === 0 ? (
            <p className="canvas-detail-empty">Terminal step: nothing follows.</p>
          ) : (
            <ul className="canvas-detail-edges">
              {outgoing.map((e) => (
                <li key={`${e.from}->${e.to}`}>
                  <button
                    className="canvas-detail-edge"
                    data-tooltip={`Open ${labelFor(e.to)}`}
                    onClick={() => onSelectStep(e.to)}
                  >
                    <Icon name="CornerDownRight" size={13} />
                    <span className="canvas-detail-edge-target">{labelFor(e.to)}</span>
                    {edgeKindLabel(e) && <span className="canvas-detail-edge-kind">{edgeKindLabel(e)}</span>}
                    {e.label && <span className="canvas-detail-edge-cond">{e.label}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="canvas-detail-section">
          <h4>
            Reached from <span className="canvas-detail-count">{incoming.length}</span>
          </h4>
          {incoming.length === 0 ? (
            <p className="canvas-detail-empty">
              {node.kind === "entry" ? "Entry point: the workflow starts here." : "No step routes here."}
            </p>
          ) : (
            <ul className="canvas-detail-edges">
              {incoming.map((e) => (
                <li key={`${e.from}->${e.to}`}>
                  <button
                    className="canvas-detail-edge"
                    data-tooltip={`Open ${labelFor(e.from)}`}
                    onClick={() => onSelectStep(e.from)}
                  >
                    <Icon name="CornerLeftUp" size={13} />
                    <span className="canvas-detail-edge-target">{labelFor(e.from)}</span>
                    {edgeKindLabel(e) && <span className="canvas-detail-edge-kind">{edgeKindLabel(e)}</span>}
                    {e.label && <span className="canvas-detail-edge-cond">{e.label}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {graph.warnings.length > 0 && (
          <section className="canvas-detail-section">
            <h4>
              Graph warnings <span className="canvas-detail-count">{graph.warnings.length}</span>
            </h4>
            <ul className="canvas-detail-warnings">
              {graph.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * Compact step detail for the board's bottom inspector (its header — kind
 * dot, name, kind tag, "Open in steps", close — lives in the panel head; see
 * CanvasOverviewPanel). Built from the same blocks the accordion and the
 * full-pane detail use, so the three surfaces can never disagree: role and
 * description, the input/capability contract chips plus timeout, elbow
 * transition rows (clicking one retargets the selection), and the selected
 * step's observed run facts when a run exists — status, duration, cost,
 * error. Absent fields stay absent.
 */
export function CanvasStepInspector({
  graph,
  node,
  run,
  onSelectStep,
  workflows,
  onOpenWorkflow,
}: CanvasStepDetailProps): JSX.Element {
  const runStep = runStepFor(run, node.id);
  return (
    <div className="canvas-inspector" data-testid="canvas-step-inspector">
      {node.role && <p className="canvas-detail-role">{node.role}</p>}
      {node.description && <p className="canvas-step-desc">{node.description}</p>}
      <StepInputContract node={node} />
      <StepCapabilities node={node} />
      {node.timeoutMs !== null && (
        <div className="canvas-input-card" data-testid={`canvas-inspector-timeout-${node.id}`}>
          <span className="canvas-input-label">Timeout</span>
          <span className="canvas-detail-timeout">{formatTimeout(node.timeoutMs)}</span>
        </div>
      )}
      <StepTransitions graph={graph} node={node} onSelectStep={onSelectStep} />
      <OpenLaunchedWorkflow node={node} workflows={workflows} onOpenWorkflow={onOpenWorkflow} />
      {runStep && (
        <div className="canvas-inspector-run" data-testid="canvas-inspector-run">
          <span className="canvas-input-label">Last run</span>
          <span className={"canvas-run-text is-" + runStep.status}>
            <StepStatusIcon status={runStep.status} />
            {runStep.status}
          </span>
          {runStep.latencyMs !== undefined && (
            <span className="canvas-inspector-run-meta">{formatTimeout(runStep.latencyMs)}</span>
          )}
          {runStep.costUsd !== undefined && (
            <span className="canvas-inspector-run-meta">{formatCostExact(runStep.costUsd)}</span>
          )}
        </div>
      )}
      {runStep?.error && <pre className="canvas-run-error">{runStep.error}</pre>}
    </div>
  );
}
