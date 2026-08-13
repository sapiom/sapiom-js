import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { RunView, StepView, WorkflowInfo } from "@shared/types";

import { formatTimeout } from "../lib/canvas-graph";
import { formatPayload } from "../lib/format-payload";
import type { RunTarget } from "../lib/use-harness-state";
import { agentUrl } from "../lib/urls";
import { ArtifactRenderer } from "./ArtifactRenderer";
import { Icon } from "./Icon";

export type EvidenceTab = "input" | "output" | "state" | "directive" | "logs" | "calls";

const EVIDENCE_TABS: Array<{ id: EvidenceTab; label: string }> = [
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "state", label: "State" },
  { id: "directive", label: "Directive" },
  { id: "logs", label: "Logs" },
  { id: "calls", label: "Calls" },
];

export function chronologicalAttempts(steps: StepView[]): StepView[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => {
      const at = a.step.startedAt ? Date.parse(a.step.startedAt) : Number.NaN;
      const bt = b.step.startedAt ? Date.parse(b.step.startedAt) : Number.NaN;
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ step }) => step);
}

function statusLabel(status: RunView["status"]): string {
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Running";
}

function targetLabel(target: RunTarget | null): string {
  return target === "prod" ? "Cloud" : target === "local" ? "Local" : "Run";
}

function runDuration(run: RunView): number | null {
  if (run.startedAt && run.finishedAt) {
    const start = Date.parse(run.startedAt);
    const end = Date.parse(run.finishedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  }
  const total = run.steps.reduce((sum, step) => sum + (step.latencyMs ?? 0), 0);
  return total > 0 ? total : null;
}

function StepGlyph({ status }: { status: StepView["status"] }): JSX.Element {
  if (status === "passed") return <Icon name="Check" size={11} />;
  if (status === "failed") return <Icon name="X" size={11} />;
  if (status === "running") return <span className="run-workspace-pulse" />;
  return <span className="run-workspace-pending" />;
}

function timelinePosition(step: StepView, run: RunView): { left: number; width: number } {
  if (!step.startedAt || !run.startedAt) return { left: 0, width: step.latencyMs ? 100 : 12 };
  const runStart = Date.parse(run.startedAt);
  const stepStart = Date.parse(step.startedAt);
  const runEnd = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const stepEnd = step.finishedAt ? Date.parse(step.finishedAt) : runEnd;
  if (![runStart, stepStart, runEnd, stepEnd].every(Number.isFinite) || runEnd <= runStart) {
    return { left: 0, width: step.latencyMs ? 100 : 12 };
  }
  return {
    left: Math.max(0, Math.min(96, ((stepStart - runStart) / (runEnd - runStart)) * 100)),
    width: Math.max(4, Math.min(100, ((stepEnd - stepStart) / (runEnd - runStart)) * 100)),
  };
}

function Timeline({
  attempts,
  run,
  selectedId,
  onSelect,
}: {
  attempts: StepView[];
  run: RunView;
  selectedId: string | null;
  onSelect: (step: StepView) => void;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="run-timeline" role="listbox" aria-label="Execution attempts" data-testid="run-timeline">
      <div className="run-timeline-title">Attempts <span>{attempts.length}</span></div>
      {attempts.map((step, index) => {
        const timing = timelinePosition(step, run);
        return (
          <button
            key={step.id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="option"
            aria-selected={selectedId === step.id}
            className="run-timeline-row"
            data-testid={`run-attempt-${step.id}`}
            data-status={step.status}
            onClick={() => onSelect(step)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              const next = (index + delta + attempts.length) % attempts.length;
              refs.current[next]?.focus();
              onSelect(attempts[next]!);
            }}
          >
            <span className="run-timeline-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="run-timeline-status" aria-label={step.status}><StepGlyph status={step.status} /></span>
            <span className="run-timeline-copy">
              <strong>{step.name}</strong>
              <small>Attempt {step.attempt ?? 1}</small>
            </span>
            <span className="run-timeline-duration">
              {step.latencyMs !== undefined ? formatTimeout(step.latencyMs) : step.status}
            </span>
            <span className="run-timeline-track" aria-hidden="true">
              <span style={{ left: `${timing.left}%`, width: `${timing.width}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function evidenceValue(step: StepView, tab: EvidenceTab): unknown | undefined {
  if (tab === "input") return step.input;
  if (tab === "output") return step.output;
  if (tab === "state") return step.sharedState;
  if (tab === "directive") return step.directive;
  if (tab === "logs") return step.logSlice;
  return step.calls;
}

function Evidence({ step, tab }: { step: StepView; tab: EvidenceTab }): JSX.Element {
  const value = evidenceValue(step, tab);
  if (value === undefined || (tab === "calls" && Array.isArray(value) && value.length === 0)) {
    return (
      <div className="run-evidence-empty">
        <Icon name="Info" size={14} /> {EVIDENCE_TABS.find((item) => item.id === tab)?.label} not recorded.
      </div>
    );
  }
  if (tab === "calls" && Array.isArray(value)) {
    return (
      <div className="run-call-list">
        {(value as NonNullable<StepView["calls"]>).map((call, index) => (
          <article className="run-call" key={`${call.capability}-${index}`}>
            <header><code>{call.capability}</code>{call.stubUsed && <span>stubbed</span>}</header>
            <div className="run-call-pair">
              <section><h5>Arguments</h5>{call.args === undefined ? <p>not recorded</p> : <pre>{formatPayload(call.args)}</pre>}</section>
              <section><h5>Result</h5>{call.result === undefined ? <p>not recorded</p> : <pre>{formatPayload(call.result)}</pre>}</section>
            </div>
          </article>
        ))}
      </div>
    );
  }
  return <pre className="run-evidence-value">{typeof value === "string" ? value : formatPayload(value)}</pre>;
}

function attemptContext(run: RunView, step: StepView): string {
  const logTail = step.logSlice?.slice(-4_000);
  return JSON.stringify({
    executionId: run.executionId,
    runStatus: run.status,
    runInput: run.input,
    runOutput: run.output,
    runError: run.error,
    attempt: {
      step: step.name,
      number: step.attempt ?? 1,
      status: step.status,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      input: step.input,
      output: step.output,
      state: step.sharedState,
      directive: step.directive,
      calls: step.calls,
      error: step.error,
      logTail,
    },
  }, null, 2);
}

function AttemptInspector({
  run,
  step,
  tab,
  onTab,
  onBack,
  onAskAgent,
}: {
  run: RunView;
  step: StepView;
  tab: EvidenceTab;
  onTab: (tab: EvidenceTab) => void;
  onBack: () => void;
  onAskAgent: (prompt: string) => void;
}): JSX.Element {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <section className="run-attempt-inspector" aria-label={`${step.name} attempt ${step.attempt ?? 1}`}>
      <header className="run-attempt-head">
        <button type="button" className="btn-ghost run-attempt-back" onClick={onBack}>
          <Icon name="ArrowLeft" size={13} /> Back
        </button>
        <div>
          <h3>{step.name}</h3>
          <p><span data-status={step.status}>{step.status}</span> · Attempt {step.attempt ?? 1}{step.latencyMs !== undefined ? ` · ${formatTimeout(step.latencyMs)}` : ""}</p>
        </div>
        <button
          type="button"
          className="btn-ghost run-attempt-debug"
          onClick={() => onAskAgent(`Help me inspect and improve this execution attempt.\n\n${attemptContext(run, step)}`)}
        >
          <Icon name="MessageSquare" size={13} /> Ask coding agent
        </button>
      </header>
      {step.error && <div className="run-attempt-error"><Icon name="TriangleAlert" size={14} /><span>{step.error}</span></div>}
      <div className="run-evidence-tabs" role="tablist" aria-label="Attempt evidence">
        {EVIDENCE_TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => { tabRefs.current[index] = node; }}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`run-evidence-${item.id}`}
            data-testid={`run-evidence-tab-${item.id}`}
            onClick={() => onTab(item.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const nextIndex = (index + delta + EVIDENCE_TABS.length) % EVIDENCE_TABS.length;
              onTab(EVIDENCE_TABS[nextIndex]!.id);
              tabRefs.current[nextIndex]?.focus();
            }}
          >{item.label}</button>
        ))}
      </div>
      <div className="run-evidence-panel" id={`run-evidence-${tab}`} role="tabpanel"><Evidence step={step} tab={tab} /></div>
    </section>
  );
}

function StubNotices({ run }: { run: RunView }): JSX.Element | null {
  const unused = run.unusedStubs ?? [];
  const warnings = run.stubWarnings ?? [];
  if (unused.length === 0 && warnings.length === 0) return null;
  return (
    <details className="run-stub-notices" data-testid="run-stub-notices">
      <summary>Stub notices <span>{unused.length + warnings.length}</span></summary>
      {unused.length > 0 && (
        <section>
          <h4>Unused stubs</h4>
          <ul>{unused.map((item) => <li key={`${item.step}:${item.key}`}><code>{item.step}</code> · {item.key}</li>)}</ul>
        </section>
      )}
      {warnings.length > 0 && (
        <section>
          <h4>Warnings</h4>
          <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </section>
      )}
    </details>
  );
}

function finalArtifact(run: RunView): { value: unknown; label: string } | null {
  if (run.output !== undefined) return { value: run.output, label: "Result" };
  const latest = [...run.steps].reverse().find((step) => step.status === "passed" && step.output !== undefined);
  return latest ? { value: latest.output, label: "Latest output" } : null;
}

export function RunWorkspace({
  run,
  target,
  workflow,
  focus,
  onToggleFocus,
  onAskAgent,
  onInspectionOpened,
  onArtifactViewed,
  onDashboardOpened,
}: {
  run: RunView;
  target: RunTarget | null;
  workflow: WorkflowInfo | null;
  focus: boolean;
  onToggleFocus: () => void;
  onAskAgent: (prompt: string) => void;
  onInspectionOpened?: () => void;
  onArtifactViewed?: () => void;
  onDashboardOpened?: () => void;
}): JSX.Element {
  const attempts = useMemo(() => chronologicalAttempts(run.steps), [run.steps]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<EvidenceTab>("output");
  const manualSelection = useRef(false);
  const artifactReportedFor = useRef<string | null>(null);
  const selected = attempts.find((step) => step.id === selectedId) ?? null;
  const artifact = finalArtifact(run);
  const duration = runDuration(run);

  useEffect(() => {
    manualSelection.current = false;
    artifactReportedFor.current = null;
    setSelectedId(null);
    setTab("output");
  }, [run.executionId]);

  useEffect(() => {
    if (manualSelection.current || run.status === "running") return;
    if (run.status === "failed") {
      const failed = [...attempts].reverse().find((step) => step.status === "failed");
      if (failed) {
        setSelectedId(failed.id);
        setTab("logs");
      }
    } else if (run.status === "completed") {
      setSelectedId(null);
    }
  }, [run.status, attempts]);

  const selectAttempt = (step: StepView): void => {
    manualSelection.current = true;
    setSelectedId(step.id);
    setTab(step.status === "failed" ? "logs" : "output");
    onInspectionOpened?.();
  };

  const overview = (
    <section className="run-overview">
      {artifact ? (
        <ArtifactRenderer
          value={artifact.value}
          label={artifact.label}
          onViewed={() => {
            if (artifactReportedFor.current === run.executionId) return;
            artifactReportedFor.current = run.executionId;
            onArtifactViewed?.();
          }}
        />
      ) : run.status === "running" ? (
        <div className="run-result-pending"><span className="run-workspace-pulse" /> Waiting for the agent result…</div>
      ) : run.error !== undefined ? (
        <div className="run-result-error"><Icon name="TriangleAlert" size={15} /><pre>{formatPayload(run.error)}</pre></div>
      ) : (
        <div className="run-result-pending">No result was recorded.</div>
      )}
      <StubNotices run={run} />
      {!focus && <Timeline attempts={attempts} run={run} selectedId={selectedId} onSelect={selectAttempt} />}
    </section>
  );

  return (
    <div className={"run-workspace" + (focus ? " is-focus" : "")} data-testid="run-workspace">
      <header className="run-workspace-header">
        <span className="run-workspace-status" data-status={run.status}>
          <StepGlyph status={run.status === "completed" ? "passed" : run.status === "failed" || run.status === "cancelled" ? "failed" : "running"} />
          {statusLabel(run.status)}
        </span>
        {duration !== null && <span>{formatTimeout(duration)}</span>}
        <span>{targetLabel(target)}</span>
        <span className="run-workspace-spacer" />
        {workflow?.definitionId != null && (
          <a href={agentUrl(workflow.definitionId)} target="_blank" rel="noreferrer" onClick={onDashboardOpened}>
            <Icon name="Cloud" size={12} /> Dashboard
          </a>
        )}
        {focus && (
          <button type="button" className="theme-toggle" onClick={onToggleFocus} aria-label="Exit Focus mode">
            <Icon name="Minimize2" size={14} />
          </button>
        )}
      </header>
      {focus ? (
        <div className="run-workspace-focus-grid">
          <Timeline attempts={attempts} run={run} selectedId={selectedId} onSelect={selectAttempt} />
          <div className="run-workspace-inspector">
            {selected ? (
              <AttemptInspector run={run} step={selected} tab={tab} onTab={setTab} onBack={() => setSelectedId(null)} onAskAgent={onAskAgent} />
            ) : overview}
          </div>
        </div>
      ) : selected ? (
        <AttemptInspector run={run} step={selected} tab={tab} onTab={setTab} onBack={() => setSelectedId(null)} onAskAgent={onAskAgent} />
      ) : overview}
    </div>
  );
}
