import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";
import type { RunView, WorkflowInfo } from "@shared/types";

import type { CanvasGraphNode } from "../lib/canvas-graph";
import { nodeKindLabel } from "../lib/canvas-graph";
import { relativeTimeLabel } from "../lib/relative-time";
import type { ObservedRun, RunTarget } from "../lib/use-harness-state";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";

interface WorkflowActionsHeaderProps {
  workflow: WorkflowInfo;
  /** Drilled step, when the pane shows a step detail instead of the board. */
  detailStep: CanvasGraphNode | null;
  onBack: () => void;
  /** Sends a prompt about the drilled step to the active session's agent. */
  onAskAgent: (prompt: string) => void;
  /** The right tab this pane projects: the board, or the Steps tab. */
  surface: "board" | "steps";
  /** "4 steps · 2 exits" from the shared graphCounts rule; null = no graph. */
  stepsSummary: string | null;
  /** The run the Steps tab is showing, when one was observed. */
  run: RunView | null;
  /** Where that run executed (prod / local) — labels the run chip. */
  runTarget: RunTarget | null;
  /** Every run observed for this session (oldest first) — ≥2 arms the
   *  run picker on the chip. */
  runs: ObservedRun[];
  onSelectRun: (executionId: string) => void;
}

/** Chip copy: "prod run completed" / "local run running". Cost-free — the
 *  inspector surfaces logs, latency, and pass/fail only. */
function runChipLabel(run: RunView, target: RunTarget | null): string {
  const kind = target ? `${target} run` : "run";
  return `${kind} ${run.status}`;
}

/**
 * The canvas pane's subheader. Renders only for the Steps list and a drilled
 * step — the board shows no subheader at all (its deployed pill and
 * expand/collapse live in the tab bar, its name in the rail), so this returns
 * null in that case.
 * - Steps list: the workflow name and the real step count, info left, no
 *   competing actions (rows are the interface).
 * - Step detail: 1×1 back left-anchored, the step's name and kind, then the
 *   right-anchored main action (Ask agent) and a ⋯ menu with the rest —
 *   the drill-down's chrome lives HERE, not inside the scroll area.
 */
export function WorkflowActionsHeader({
  workflow,
  detailStep,
  onBack,
  onAskAgent,
  surface,
  stepsSummary,
  run,
  runTarget,
  runs,
  onSelectRun,
}: WorkflowActionsHeaderProps): JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // The steps-mode run picker: its own open state and refs — the ⋯
  // menu above belongs to the detail mode and never coexists with this one.
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const runMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeRunMenu = useCallback(() => setRunMenuOpen(false), []);

  if (detailStep) {
    return (
      <div className="workflow-actions-header" data-testid="workflow-actions-header">
        <button
          className="theme-toggle"
          data-testid="canvas-detail-back"
          onClick={onBack}
          aria-label="Back to the steps list"
          data-tooltip="Back to the steps list"
        >
          <Icon name="ArrowLeft" size={14} />
        </button>
        <span className="workflow-actions-name" data-testid="canvas-detail-title">
          {detailStep.label}
        </span>
        <span className={"canvas-detail-kind node--" + detailStep.kind}>{nodeKindLabel(detailStep.kind)}</span>

        <button
          className="btn-ghost canvas-detail-ask"
          data-testid="canvas-detail-ask"
          aria-label="Ask agent"
          data-tooltip="Sends the request to the agent in the terminal"
          onClick={() => onAskAgent(`Walk me through the "${detailStep.label}" step of this agent: what it does, its inputs and outputs, and its transitions.`)}
        >
          <Icon name="MessageSquare" size={13} />
          {/* Hidden by the subheader's container query when the pane is too
              narrow — icon + tooltip + aria-label keep naming the action. */}
          <span className="canvas-detail-ask-label">Ask agent</span>
        </button>
        <div className="canvas-detail-menu-wrap">
          <button
            ref={menuTriggerRef}
            className="theme-toggle"
            data-testid="canvas-detail-menu"
            aria-label={`More actions for ${detailStep.label}`}
            data-tooltip="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="MoreHorizontal" size={14} />
          </button>
          <AnchoredPopover
            open={menuOpen}
            anchorRef={menuTriggerRef}
            onDismiss={closeMenu}
            placement="down-end"
            className="canvas-detail-menu"
            role="menu"
            testid="canvas-detail-menu-popover"
          >
              <button
                role="menuitem"
                className="profile-menu-item"
                onClick={() => {
                  onAskAgent(`Modify the "${detailStep.label}" step of this agent. Show me the step's code first, then propose the change.`);
                  closeMenu();
                }}
              >
                <Icon name="Wand2" size={13} />
                Ask agent to modify
              </button>
              <button
                role="menuitem"
                className="profile-menu-item"
                onClick={() => {
                  void navigator.clipboard?.writeText(detailStep.label).catch(() => {});
                  closeMenu();
                }}
              >
                <Icon name="Copy" size={13} />
                Copy step name
              </button>
          </AnchoredPopover>
        </div>
      </div>
    );
  }

  if (surface === "steps") {
    const chipBody = run && (
      <>
        {run.status === "running" && <span className="canvas-run-status is-running" aria-hidden="true" />}
        {runChipLabel(run, runTarget)}
      </>
    );
    return (
      <div
        className={"workflow-actions-header" + (run ? " has-run" : "")}
        data-testid="workflow-actions-header"
      >
        <span className="workflow-actions-name">{workflow.name}</span>
        <span className="workflow-actions-count" data-testid="canvas-steps-count">
          {stepsSummary ?? "no steps"}
        </span>
        {/* One observed run: a plain status chip. Several: the chip is
            the run picker — any past run is one click away. */}
        {run && runs.length <= 1 && (
          <span className={"status-tag canvas-run-chip is-" + run.status} data-testid="canvas-run-chip">
            {chipBody}
          </span>
        )}
        {run && runs.length > 1 && (
          <div className="canvas-run-picker-wrap">
            <button
              ref={runMenuTriggerRef}
              className={"status-tag status-tag-action canvas-run-chip canvas-run-chip--picker is-" + run.status}
              data-testid="canvas-run-chip"
              aria-haspopup="menu"
              aria-expanded={runMenuOpen}
              aria-label={`Pick a run to inspect (${runs.length} observed)`}
              data-tooltip="Pick a run to inspect"
              onClick={() => setRunMenuOpen((v) => !v)}
            >
              {chipBody}
              <Icon name="ChevronDown" size={12} />
            </button>
            <AnchoredPopover
              open={runMenuOpen}
              anchorRef={runMenuTriggerRef}
              onDismiss={closeRunMenu}
              placement="down-end"
              className="canvas-run-menu"
              role="menu"
              testid="canvas-run-menu"
            >
                {[...runs].reverse().map((observed, reversedIndex) => {
                  const ordinal = runs.length - reversedIndex;
                  const active = observed.run.executionId === run.executionId;
                  // Each row carries when the Studio observed the run start —
                  // enough to tell runs apart at a glance. Coarse relative
                  // time on purpose: a client observation is not a server
                  // timestamp.
                  const meta = relativeTimeLabel(observed.observedAt);
                  return (
                    <button
                      key={observed.run.executionId}
                      role="menuitemradio"
                      aria-checked={active}
                      className={"profile-menu-item" + (active ? " is-selected" : "")}
                      data-testid={`canvas-run-option-${observed.run.executionId}`}
                      title={observed.run.executionId}
                      onClick={() => {
                        onSelectRun(observed.run.executionId);
                        closeRunMenu();
                      }}
                    >
                      <Icon name={active ? "Check" : "Play"} size={13} />
                      <span>{`run ${ordinal} · ${observed.run.status} · ${observed.target}`}</span>
                      <span className="canvas-run-option-meta">{meta}</span>
                    </button>
                  );
                })}
            </AnchoredPopover>
          </div>
        )}
      </div>
    );
  }

  // The board renders no subheader at all: its deployed pill (→ dashboard) and
  // expand/collapse live in the tab bar, its name in the rail. Tidjane's board
  // design has nothing between the tabs and the canvas, so return null here.
  return null;
}
