import { useState } from "react";
import type { JSX, MouseEvent } from "react";
import type { RunView, StepView, WorkflowInfo } from "@shared/types";
import { stepIsStubbed, stubNotice } from "@shared/stub-feedback";

import type { CanvasGraph, CanvasGraphEdge, CanvasGraphNode } from "../lib/canvas-graph";
import { formatTimeout, stepFacts, stepInputFields } from "../lib/canvas-graph";
import { formatPayload } from "../lib/format-payload";
import { runStepFor } from "../lib/run-step";
import {
  extractStepContext,
  extractStepLinks,
} from "../lib/extract-step-context";
import type { DeployProgress, RunTarget } from "../lib/use-harness-state";
import { agentUrl } from "../lib/urls";
import { ArtifactRenderer } from "./ArtifactRenderer";
import { Icon } from "./Icon";

/**
 * The per-step "stubbed" chip (WB15-2). Rendered for a step that ran in a
 * stub-served (offline local) run — see {@link stepIsStubbed}. Read-only and
 * capability-not-model: it states only that the step's capability calls were
 * served by stubs, with no provider/model named. A tooltip explains why. Absent
 * for real runs and for steps a run never reached (honesty).
 */
function StubbedChip(): JSX.Element {
  return (
    <span
      className="canvas-run-stub-chip"
      data-testid="canvas-run-stub-chip"
      data-tooltip="Sapiom capability calls in this local run were served by stubs — not real Sapiom calls"
    >
      stubbed
    </span>
  );
}

/**
 * A labelled disclosure for raw diagnostic payloads (Input / Logs) with
 * a Copy button — the one place these render, so every payload gets the same
 * copy affordance. `text` is pre-stringified by the caller (formatPayload for
 * JSON values, the raw string for logs). Copying reuses the SnippetPanel copy
 * pattern (writeText → "Copied" for 1.5s, errors swallowed). The Copy button
 * lives in the summary but stops the click from toggling the disclosure.
 * Callers gate on `!== undefined` so honest-absence still holds (this only
 * renders a payload that exists).
 */
function PayloadBlock({
  label,
  text,
  testid,
  copyTestid,
  className,
  defaultOpen = false,
}: {
  label: string;
  text: string;
  testid?: string;
  copyTestid?: string;
  className?: string;
  defaultOpen?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (event: MouseEvent<HTMLButtonElement>): void => {
    // Don't let the button toggle the <details> it sits inside.
    event.stopPropagation();
    event.preventDefault();
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked — silent, mirrors SnippetPanel */
      },
    );
  };
  return (
    <details
      className={"canvas-run-logs payload-block" + (className ? " " + className : "")}
      data-testid={testid}
      open={defaultOpen}
    >
      <summary>
        <span className="payload-block-caret" aria-hidden="true">
          <Icon name="ChevronRight" size={12} />
        </span>
        <span className="payload-block-label">{label}</span>
        <button
          type="button"
          className={"payload-copy" + (copied ? " is-copied" : "")}
          data-testid={copyTestid}
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          <Icon name={copied ? "Check" : "Copy"} size={11} />
          {copied ? "Copied" : "Copy"}
        </button>
      </summary>
      <pre>{text}</pre>
    </details>
  );
}

/** Canvas step evidence uses the same safe, bounded artifact experience as run
 * results, but starts collapsed to keep the board inspector compact. Keeping
 * this wrapper shared between Canvas and Steps node detail prevents drift. */
function CanvasEvidenceArtifact({
  label,
  value,
  testId,
}: {
  label: "Input" | "Output" | "Logs" | "Arguments" | "Result";
  value: unknown;
  testId: string;
}): JSX.Element {
  return <ArtifactRenderer value={value} label={label} testId={testId} defaultOpen={false} />;
}

/**
 * "Links" block: scans the step's output, log slice, and call results for
 * http(s) URLs and renders them as clickable thumbnails (images) or labelled
 * anchor links (other URLs). Rendered in BOTH surfaces (inspector + full pane).
 * Absent when no URLs are found — never renders an empty block.
 *
 * All links open in a new tab: image URLs render as thumbnails, other URLs as
 * a labelled "Open" anchor.
 */
/** The clickable list of extracted URLs — image URLs as thumbnails, others as
 *  labelled "Open" anchors. Shared by the per-step links block and the run
 *  summary's aggregated results, so both render links identically. */
function LinksList({
  links,
  testid,
}: {
  links: ReturnType<typeof extractStepLinks>;
  testid?: string;
}): JSX.Element {
  return (
    <div className="canvas-links-list" data-testid={testid}>
      {links.map(({ url, kind }) =>
        kind === "image" ? (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="canvas-link-thumb-wrap"
            data-testid="canvas-link-image"
          >
            <img src={url} alt="" className="canvas-link-thumb" loading="lazy" />
          </a>
        ) : (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="canvas-link-item"
            data-testid="canvas-link-other"
          >
            <Icon name="ExternalLink" size={12} />
            <span className="canvas-link-url">Open</span>
          </a>
        ),
      )}
    </div>
  );
}

function StepLinksBlock({ step }: { step: StepView }): JSX.Element | null {
  const links = extractStepLinks(step);
  if (links.length === 0) return null;
  return (
    <section className="canvas-detail-section" data-testid="canvas-detail-links">
      <h4>Links</h4>
      <LinksList links={links} />
    </section>
  );
}

/** The run-status glyph for the summary header — reuses the per-step status
 *  vocabulary. `running` is the bare pulse dot; terminal states get an icon. */
function RunStatusGlyph({ status }: { status: RunView["status"] }): JSX.Element {
  if (status === "completed")
    return (
      <span className="canvas-run-status is-passed" aria-label="completed">
        <Icon name="Check" size={11} />
      </span>
    );
  if (status === "failed")
    return (
      <span className="canvas-run-status is-failed" aria-label="failed">
        <Icon name="X" size={11} />
      </span>
    );
  if (status === "cancelled")
    return (
      <span className="canvas-run-status is-pending" aria-label="cancelled">
        <Icon name="Minus" size={11} />
      </span>
    );
  return <span className="canvas-run-status is-running" aria-label="running" />;
}

/**
 * A deploy landing in the Steps surface, so Deploy reads as an ACTION with
 * progress and a payoff (like a run) rather than a silent toast. Shows the live
 * phase (linking → building) with a spinner, and on `ready` a completion banner
 * with the dashboard link + a jump to the integration snippet ("Trigger from
 * your code"). Dismissable; on error it surfaces the server's message.
 */
export function DeployStatusBanner({
  deployState,
  workflow,
  onDismiss,
  onOpenCode,
}: {
  deployState: DeployProgress;
  workflow: WorkflowInfo | null;
  onDismiss: () => void;
  onOpenCode: () => void;
}): JSX.Element {
  const dashboardUrl = workflow?.definitionId != null ? agentUrl(workflow.definitionId) : null;
  const inFlight = deployState.phase === "linking" || deployState.phase === "building";
  const label =
    deployState.phase === "linking"
      ? "Creating the agent on Sapiom…"
      : deployState.phase === "building"
        ? "Deploying — building on Sapiom…"
        : deployState.phase === "ready"
          ? "Deployed to Sapiom"
          : "Deploy failed";
  return (
    <section
      className={"deploy-status-banner is-" + deployState.phase}
      data-testid="deploy-status-banner"
      data-phase={deployState.phase}
    >
      <div className="deploy-status-head">
        {inFlight ? (
          <span className="canvas-task-spinner" aria-hidden="true" />
        ) : (
          <RunStatusGlyph status={deployState.phase === "ready" ? "completed" : "failed"} />
        )}
        <span className="deploy-status-label">{label}</span>
        <button
          type="button"
          className="deploy-status-dismiss"
          data-testid="deploy-status-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <Icon name="X" size={12} />
        </button>
      </div>
      {deployState.phase === "error" && deployState.message && (
        <pre className="canvas-run-error">{deployState.message}</pre>
      )}
      {deployState.phase === "ready" && (
        <div className="deploy-status-actions">
          {dashboardUrl && (
            <a
              className="status-tag status-tag-action"
              data-testid="deploy-open-dashboard"
              href={dashboardUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="Cloud" size={12} />
              Open in Sapiom
            </a>
          )}
          <button
            type="button"
            className="status-tag status-tag-action"
            data-testid="deploy-open-code"
            onClick={onOpenCode}
          >
            <Icon name="Code" size={12} />
            Trigger from your code
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * "Capability calls" block: rendered when `step.calls` is present and
 * non-empty (local/offline runs). Each call shows the dotted capability id
 * with a "(stubbed)" marker when the call was served by a stub. Recorded
 * arguments and results reuse the collapsed Canvas artifact viewer. Absent
 * evidence stays absent, as do calls in production traces that do not carry
 * call records.
 *
 * Provider rule: only the capability dotted id is shown — never a provider
 * or model name.
 */
function CapabilityCallsBlock({ step }: { step: StepView }): JSX.Element | null {
  if (!step.calls || step.calls.length === 0) return null;
  return (
    <section className="canvas-detail-section" data-testid="canvas-detail-capability-calls">
      <h4>Capability calls</h4>
      <div className="canvas-capability-calls">
        {step.calls.map((call, idx) => (
          <div key={`${call.capability}-${idx}`} className="canvas-capability-call">
            <div className="canvas-capability-call-head">
              <code className="canvas-input-field">{call.capability}</code>
              {call.stubUsed && (
                <span
                  className="canvas-run-stub-chip"
                  data-testid={`canvas-call-stub-chip-${call.capability}`}
                >
                  stubbed
                </span>
              )}
            </div>
            {call.args !== undefined && (
              <CanvasEvidenceArtifact
                label="Arguments"
                value={call.args}
                testId={`canvas-call-arguments-${call.capability}`}
              />
            )}
            {call.result !== undefined && (
              <CanvasEvidenceArtifact
                label="Result"
                value={call.result}
                testId={`canvas-call-result-${call.capability}`}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The read-only stub-hygiene notice (WB15-2): a run's `unusedStubs` (a supplied
 * stub that matched no capability call — a no-op mock, usually a typo/wrong
 * path) and `stubWarnings` (a stub value with the wrong shape). Renders NOTHING
 * when the run is clean or absent ({@link stubNotice} returns null) — an honest
 * notice never shows a "0 issues" panel. Read-only: it reports, it never edits
 * (editing stubs is a deferred fast-follow).
 */
export function StubNoticeSection({ run }: { run: RunView | null }): JSX.Element | null {
  const notice = stubNotice(run);
  if (!notice) return null;
  return (
    <section className="canvas-detail-section" data-testid="canvas-detail-stub-notice">
      <h4>Stub notices</h4>
      {notice.unusedStubs && (
        <div className="canvas-stub-notice" data-testid="canvas-stub-unused">
          <span className="canvas-input-label">Unused stubs</span>
          <p className="canvas-stub-notice-hint">
            Supplied but matched no capability call — likely a typo or wrong path.
          </p>
          <ul className="canvas-detail-warnings">
            {notice.unusedStubs.map((u) => (
              <li key={`${u.step} ${u.key}`}>
                <code className="canvas-input-field">{u.key}</code> in {u.step}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice.stubWarnings && (
        <div className="canvas-stub-notice" data-testid="canvas-stub-warnings">
          <span className="canvas-input-label">Stub warnings</span>
          <p className="canvas-stub-notice-hint">
            Matched a call but had the wrong shape.
          </p>
          <ul className="canvas-detail-warnings">
            {notice.stubWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The run's origin as a plain phrase ("prod run" / "local run"), or a bare
 *  "run" when the bus message predates the target field. Cost-free: the
 *  inspector shows logs, latency, and pass/fail only. */
function runKindLabel(target: RunTarget | null): string {
  return target ? `${target} run` : "run";
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
 * it (CornerLeftUp). Read-only information for the steps accordion; the
 * board's bottom inspector relies on the chart itself for navigation.
 */
export function StepTransitions({
  graph,
  node,
}: {
  graph: CanvasGraph;
  node: CanvasGraphNode;
}): JSX.Element | null {
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const incoming = graph.edges.filter((e) => e.to === node.id);
  if (outgoing.length === 0 && incoming.length === 0) return null;
  const labelFor = (id: string): string => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const row = (edge: CanvasGraphEdge, target: string, icon: "CornerDownRight" | "CornerLeftUp"): JSX.Element => {
    const key = `${icon}${edge.from}->${edge.to}`;
    return (
      <div key={key} className="canvas-step-transition">
        <Icon name={icon} size={12} />
        <span className="canvas-step-transition-target">{labelFor(target)}</span>
        {edge.label && <span className="canvas-step-transition-cond">{edge.label}</span>}
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
      Open agent <Icon name="ArrowRight" size={12} />
    </button>
  );
}

/**
 * Run-only steps view: when a run has been observed but the canvas
 * has not posted a structural graph (nothing visualized, or a document
 * without the graph contract), the real per-step data still renders —
 * name, status, latency, error, logs — instead of "No steps yet".
 * Structure (transitions, contracts) needs Visualize; the hint says so.
 */
export function RunStepsList({ run, target }: { run: RunView; target: RunTarget | null }): JSX.Element {
  return (
    <div className="canvas-steps-list" data-testid="canvas-run-fallback">
      <div className="canvas-steps-label">
        Run steps
        <span className="canvas-steps-run-note" data-testid="canvas-steps-run-note">
          {runKindLabel(target)}
        </span>
      </div>
      {run.steps.map((step, index) => {
        const meta = [
          step.latencyMs !== undefined ? formatTimeout(step.latencyMs) : null,
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
              {stepIsStubbed(run, step.name) && <StubbedChip />}
              <span className="canvas-step-meta">{meta.join(" · ")}</span>
              <span aria-hidden="true" />
            </div>
            {(step.error || step.logSlice) && (
              <div className="canvas-step-expand">
                {step.error && <pre className="canvas-run-error">{step.error}</pre>}
                {step.logSlice && (
                  <PayloadBlock
                    label="Logs"
                    text={step.logSlice}
                    copyTestid={`payload-copy-logs-${step.id}`}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      <StubNoticeSection run={run} />
      <p className="canvas-empty-hint">
        Agent run data only. Open the Canvas tab for the diagram — transitions and contracts come from the agent.
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
 * shows its real latency. Absent run fields stay absent - no zeros, no
 * placeholder columns.
 */
export function CanvasStepsList({
  graph,
  run,
  runTarget,
  workflows,
  onOpenWorkflow,
  onAskAgent,
  expandedId,
  onToggle,
}: {
  graph: CanvasGraph;
  /** The session's shown run; per-step status/latency render only
   *  when present - structure-only lists carry no run columns at all. */
  run: RunView | null;
  /** Where that run executed (prod / local); null when the bus message
   *  predates the target field. */
  runTarget: RunTarget | null;
  /** Registry workflows — launched-workflow nodes link through to theirs. */
  workflows: WorkflowInfo[];
  onOpenWorkflow: (path: string) => void;
  /** Sends a prompt to the terminal's coding agent (per-step actions in the
   *  inline detail). */
  onAskAgent: (text: string) => void;
  expandedId: string | null;
  onToggle: (id: string) => void;
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
        {/* The run's origin leads the list — prod vs local at a glance
            before any row is read. */}
        {run && (
          <span className="canvas-steps-run-note" data-testid="canvas-steps-run-note">
            {runKindLabel(runTarget)}
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
              {runStep && stepIsStubbed(run, node.id) && <StubbedChip />}
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
                {/* The full step detail lives HERE, inline — clicking a step
                    opens it as a dropdown, not a separate slide-in view. */}
                <CanvasStepDetail
                  graph={graph}
                  node={node}
                  run={run}
                  workflows={workflows}
                  onOpenWorkflow={onOpenWorkflow}
                  onAskAgent={onAskAgent}
                />
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
  /** Registry workflows — launched-workflow nodes link through to theirs. */
  workflows: WorkflowInfo[];
  onOpenWorkflow: (path: string) => void;
  /** Sends a prompt to the terminal's coding agent — powers the per-step
   *  "Ask coding agent" / "Ask to modify" actions. Absent = no actions row. */
  onAskAgent?: (text: string) => void;
}

/**
 * Per-step detail, rendered INLINE inside the step's list-row dropdown (see
 * CanvasStepsList) — the step's role and description, its per-step run IO/logs,
 * capability calls, contract, and read-only lineage (what it leads to / what
 * reaches it), plus a compact row of coding-agent actions.
 */
export function CanvasStepDetail({
  graph,
  node,
  run,
  workflows,
  onOpenWorkflow,
  onAskAgent,
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
        {onAskAgent && (
          <div className="canvas-detail-actions">
            <button
              type="button"
              className="btn-ghost canvas-detail-ask"
              data-testid="canvas-detail-ask"
              data-tooltip="Ask the coding agent in the terminal"
              onClick={() =>
                onAskAgent(
                  `Walk me through the "${node.label}" step of this agent: what it does, its inputs and outputs, and its transitions.`,
                )
              }
            >
              <Icon name="MessageSquare" size={13} />
              Ask coding agent
            </button>
            <button
              type="button"
              className="btn-ghost"
              data-testid="canvas-detail-modify"
              data-tooltip="Ask the coding agent to change this step"
              onClick={() =>
                onAskAgent(
                  `Modify the "${node.label}" step of this agent. Show me the step's code first, then propose the change.`,
                )
              }
            >
              <Icon name="Wand2" size={13} />
              Ask to modify
            </button>
            <button
              type="button"
              className="btn-ghost"
              data-testid="canvas-detail-copy-name"
              data-tooltip="Copy the step name"
              onClick={() => void navigator.clipboard?.writeText(node.label).catch(() => {})}
            >
              <Icon name="Copy" size={13} />
              Copy name
            </button>
          </div>
        )}
        <OpenLaunchedWorkflow node={node} workflows={workflows} onOpenWorkflow={onOpenWorkflow} />

        {runStep && (
          <section className="canvas-detail-section" data-testid="canvas-detail-run">
            <h4>Agent run</h4>
            <div className="canvas-detail-contract">
              <span className="canvas-input-label">Status</span>
              <span className={"canvas-run-text is-" + runStep.status}>
                <StepStatusIcon status={runStep.status} />
                {runStep.status}
                {stepIsStubbed(run, node.id) && <StubbedChip />}
              </span>
            </div>
            {runStep.latencyMs !== undefined && (
              <div className="canvas-detail-contract">
                <span className="canvas-input-label">Duration</span>
                <span className="canvas-detail-timeout">{formatTimeout(runStep.latencyMs)}</span>
              </div>
            )}
            {/* Real per-step IO — the value this step actually ran on and what
                it produced. Gated on `!== undefined` (not truthiness) so an
                honest `null`/`false`/`0`/`""` still renders; a step that never
                carried an input/output shows no block at all (no fabrication).
                Capability, not model: these are the step's own payloads, with
            no provider/model surfaced anywhere. */}
            {runStep.input !== undefined && (
              <CanvasEvidenceArtifact
                label="Input"
                value={runStep.input}
                testId={`canvas-detail-run-input-${node.id}`}
              />
            )}
            {runStep.output !== undefined && (
              <CanvasEvidenceArtifact
                label="Output"
                value={runStep.output}
                testId={`canvas-detail-run-output-${node.id}`}
              />
            )}
            {runStep.error && <pre className="canvas-run-error">{runStep.error}</pre>}
            {runStep.logSlice && (
              <CanvasEvidenceArtifact
                label="Logs"
                value={runStep.logSlice}
                testId={`canvas-detail-run-logs-${node.id}`}
              />
            )}
          </section>
        )}

        {/* Capability calls block: local runs carry per-call traces with stub
            values; prod runs leave this absent — that is correct, not a bug. */}
        {runStep && <CapabilityCallsBlock step={runStep} />}

        {/* Links block: scans output, logs, and call results for URLs.
            Prod preview/download/research links live in output/logs;
            local stub results can also carry URLs. */}
        {runStep && <StepLinksBlock step={runStep} />}

        {/* Run-level stub notices (read-only) — self-gates to null on a clean or
            non-stub run, and shows regardless of whether THIS step ran, so a
            no-op/wrong-shape stub is never hidden behind step selection. */}
        <StubNoticeSection run={run} />

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
                  <div className="canvas-detail-edge">
                    <Icon name="CornerDownRight" size={13} />
                    <span className="canvas-detail-edge-target">{labelFor(e.to)}</span>
                    {edgeKindLabel(e) && <span className="canvas-detail-edge-kind">{edgeKindLabel(e)}</span>}
                    {e.label && <span className="canvas-detail-edge-cond">{e.label}</span>}
                  </div>
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
              {node.kind === "entry" ? "Entry point: the agent starts here." : "No step routes here."}
            </p>
          ) : (
            <ul className="canvas-detail-edges">
              {incoming.map((e) => (
                <li key={`${e.from}->${e.to}`}>
                  <div className="canvas-detail-edge">
                    <Icon name="CornerLeftUp" size={13} />
                    <span className="canvas-detail-edge-target">{labelFor(e.from)}</span>
                    {edgeKindLabel(e) && <span className="canvas-detail-edge-kind">{edgeKindLabel(e)}</span>}
                    {e.label && <span className="canvas-detail-edge-cond">{e.label}</span>}
                  </div>
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
 * step's observed run facts when a run exists — status, duration, error.
 * Absent fields stay absent.
 *
 * Debug macros (restored from the pre-SAP-1767 StepDetailPanel) fire when
 * a session is live: each prepends `extractStepContext(runStep, trace, facts)`
 * to its question and injects the result into the active terminal. The inject
 * path is identical to the action-bar macros (App → harness.injectInput). No
 * cost data is injected — `extractStepContext` is cost-free by contract.
 */
export function CanvasStepInspector({
  node,
  run,
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
      <OpenLaunchedWorkflow node={node} workflows={workflows} onOpenWorkflow={onOpenWorkflow} />
      {runStep && (
        <div className="canvas-inspector-run" data-testid="canvas-inspector-run">
          <span className="canvas-input-label">Agent run</span>
          <span className={"canvas-run-text is-" + runStep.status}>
            <StepStatusIcon status={runStep.status} />
            {runStep.status}
            {stepIsStubbed(run, node.id) && <StubbedChip />}
          </span>
          {runStep.latencyMs !== undefined && (
            <span className="canvas-inspector-run-meta">{formatTimeout(runStep.latencyMs)}</span>
          )}
        </div>
      )}
      {/* Per-step IO — same honest-absence gate as the full-pane detail:
          gated on !==undefined so null/false/0/"" still render. */}
      {runStep?.input !== undefined && (
        <CanvasEvidenceArtifact
          label="Input"
          value={runStep.input}
          testId={`canvas-inspector-run-input-${node.id}`}
        />
      )}
      {runStep?.output !== undefined && (
        <CanvasEvidenceArtifact
          label="Output"
          value={runStep.output}
          testId={`canvas-inspector-run-output-${node.id}`}
        />
      )}
      {runStep?.error && <pre className="canvas-run-error">{runStep.error}</pre>}
      {runStep?.logSlice && (
        <CanvasEvidenceArtifact
          label="Logs"
          value={runStep.logSlice}
          testId={`canvas-inspector-run-logs-${node.id}`}
        />
      )}
      {/* Capability calls: local runs carry per-call stub traces; absent for
          prod runs — that is correct, not a bug. */}
      {runStep && <CapabilityCallsBlock step={runStep} />}
      {/* Links: scan output, logs, and call results for URLs. */}
      {runStep && <StepLinksBlock step={runStep} />}
      <StubNoticeSection run={run} />
    </div>
  );
}

/**
 * The step chat: debug macros + a free-form ask, injected into the active
 * terminal session. A STANDALONE panel — toggled by the canvas 💬 button,
 * closed by default, and independent of the step-detail info panel (both can be
 * open at once). With a step selected it targets that step (context-aware
 * macros); with none it is a general ask about the workflow.
 */
export function CanvasChatPanel({
  node,
  run,
  onInjectPrompt,
  onClose,
}: {
  node: CanvasGraphNode | null;
  run: RunView | null;
  onInjectPrompt: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const runStep = node ? runStepFor(run, node.id) : null;
  const [freeformText, setFreeformText] = useState("");

  /** Prepend the selected step's context (when there is one) and inject. */
  function inject(question: string): void {
    if (!node) {
      onInjectPrompt(question);
      return;
    }
    const trace = runStep
      ? {
          input: runStep.input,
          output: runStep.output,
          calls: runStep.calls,
          unusedStubs: run?.unusedStubs?.map((u) => u.key),
          stubWarnings: run?.stubWarnings,
        }
      : undefined;
    const facts = node.capabilities.length > 0 ? { capabilities: node.capabilities } : undefined;
    const ctx = extractStepContext(runStep ?? { id: node.id, name: node.id, status: "pending" }, trace, facts);
    onInjectPrompt(`${ctx}\n\n${question}`);
  }

  function handleFreeformAsk(): void {
    const trimmed = freeformText.trim();
    if (!trimmed) return;
    inject(trimmed);
    setFreeformText("");
  }

  return (
    <div className="canvas-chat-panel" data-testid="canvas-chat-panel">
      <div className="canvas-chat-head">
        <span className="canvas-chat-title" data-testid="canvas-chat-title">
          {node ? `Chat · ${node.label}` : "Chat"}
        </span>
        <button
          className="theme-toggle canvas-chat-close"
          data-testid="canvas-chat-close"
          aria-label="Close chat"
          data-tooltip="Close chat"
          onClick={onClose}
        >
          <Icon name="X" size={13} />
        </button>
      </div>
      <div className="canvas-inspector-macros" data-testid="canvas-inspector-macros">
        {node && (
          <>
            <button
              className="canvas-inspector-macro-btn btn-ghost"
              data-testid="canvas-macro-slow"
              onClick={() => inject("Why is this step slow / stuck?")}
            >
              Why slow / stuck?
            </button>
            <button
              className={"canvas-inspector-macro-btn " + (runStep?.status === "failed" ? "btn-primary" : "btn-ghost")}
              data-testid="canvas-macro-debug"
              onClick={() => inject("Debug this step")}
            >
              Debug this step
            </button>
            <button
              className="canvas-inspector-macro-btn btn-ghost"
              data-testid="canvas-macro-explain"
              onClick={() => inject("Explain this step")}
            >
              Explain this step
            </button>
          </>
        )}
        <div className="canvas-inspector-freeform">
          <textarea
            className="canvas-inspector-freeform-input"
            data-testid="canvas-freeform-input"
            placeholder={node ? "Ask about this step…" : "Ask about this agent…"}
            rows={1}
            value={freeformText}
            onChange={(e) => setFreeformText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleFreeformAsk();
              }
            }}
          />
          <button
            className="btn-primary canvas-inspector-freeform-ask"
            data-testid="canvas-freeform-ask"
            disabled={!freeformText.trim()}
            onClick={handleFreeformAsk}
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}
