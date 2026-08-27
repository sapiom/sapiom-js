import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { macroNeedsReadySession } from "../lib/macro-actions";
import { macroDisabledReason } from "../lib/macro-gating";
import { lifecycleVerbGate } from "../lib/session-scope";
import type { RunTarget } from "../lib/use-harness-state";
import {
  loadStoredRunTarget,
  saveStoredRunTarget,
} from "../lib/run-input";
import { track } from "../lib/track";
import { agentUrl } from "../lib/urls";
import { workflowDeploymentState } from "../lib/workflow-deployment";
import { RunTargetMenu } from "./RunTargetMenu";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

interface SessionStepsBarProps {
  workflow: WorkflowInfo;
  activeSessionId: string | null;
  /** The active session is live and accepting input. */
  sessionReady: boolean;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef) => void;
  /** Opens the unified input sheet for the selected execution target. */
  onRequestRun: (target: RunTarget, returnFocus: HTMLElement | null) => void;
  /** Dev server the agent started in this session (port.detected), if any. */
  preview: { port: number; url: string } | null;
  /** Error message from the last failed deploy for this workflow, or null. */
  lastDeployError: string | null;
  /** Whether the user is authenticated (gates auth-requiring actions). */
  authenticated: boolean;
  /** Bumped by the parent on every direct-action settle, so the pending ring
   *  always clears even when neither deployment state nor `lastDeployError` flips. */
  directActionSettleSeq: number;
  /** Target of the run currently in flight for this session ("local" ↔ Test,
   *  "prod" ↔ Run), or null. Tied to the real run status (not the brief pending
   *  ring), so the acting button pulses for the run's whole duration. */
  runningTarget: RunTarget | null;
}

/**
 * The agent's action cluster, right-anchored inside the single session bar (no
 * longer its own row). Per Sapiom's model these are repeatable ACTIONS, not
 * one-way stages. Order is fixed at every width: Prod globe → Test → Run →
 * Deploy.
 *   Prod (globe) = open THIS agent in the Sapiom dashboard; disabled, with its
 *                  reason, until the agent has a definition to open
 *   Test         = run_local  (Sapiom capabilities stubbed; no auth)
 *   Run          = prod_run   (real cloud execution; needs a ready build + auth)
 *   Deploy       = deploy     (push + cloud build; needs auth)
 *
 * The filled CTA follows runnable state: a ready build fills Run; otherwise
 * Deploy is primary. The lifecycle pill lives once in the right-pane header,
 * so the bar carries no duplicate.
 */
export function SessionStepsBar({
  workflow,
  activeSessionId,
  sessionReady,
  macros,
  onRunMacro,
  onRequestRun,
  preview,
  lastDeployError,
  authenticated,
  directActionSettleSeq,
  runningTarget,
}: SessionStepsBarProps): JSX.Element {
  const macroFor = (id: string): MacroDef | undefined => macros.find((m) => m.id === id);
  const deploymentState = workflowDeploymentState(workflow, lastDeployError);
  const runnable = deploymentState === "ready";

  // Launched-but-not-durable feedback: a clicked action shows a dotted
  // "in flight" ring until a durable signal lands. The ring clears on ANY
  // terminal outcome — success OR failure — by including all relevant settled
  // state in the useEffect deps:
  //   - workflow.path: re-binding a session clears the pending id.
  //   - deploymentState: the cloud build advances or fails.
  //   - lastDeployError: a failed deploy sets this; ring must not persist.
  //   - directActionSettleSeq: bumped by the parent on EVERY direct-action
  //     settle (success or failure), covering the cases where deployed and
  //     lastDeployError don't change (e.g. re-deploy of an already-deployed
  //     workflow, or a prod/local run completing without a re-bind).
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [preferredTarget, setPreferredTarget] = useState<RunTarget>(() =>
    loadStoredRunTarget(workflow.path),
  );
  const runMenuButtonRef = useRef<HTMLButtonElement>(null);
  const runMainButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setPendingId(null);
  }, [workflow.path, deploymentState, lastDeployError, directActionSettleSeq]);
  useEffect(() => {
    setPreferredTarget(loadStoredRunTarget(workflow.path));
  }, [workflow.path]);

  const actions: {
    id: string;
    label: string;
    icon: string;
    macro?: MacroDef;
    testId: string;
    hint: string;
    primary?: boolean;
    needsDeploy?: boolean;
    needsAuth?: boolean;
  }[] = [
    {
      id: "deploy",
      label: "Deploy",
      icon: "CloudUpload",
      macro: macroFor("deploy"),
      testId: "session-step-deploy",
      hint: "Deploy: push and build on Sapiom.",
      needsAuth: true,
      // Until a ready build exists, Deploy is the next act.
      primary: !runnable,
    },
  ].filter((action) => action.macro);

  /**
   * The verbs are GATED by their subject, not merely aimed at it (SAP-2931).
   *
   * `workflow` is the rail SELECTION, and every enabled/disabled decision in
   * this bar comes out of `lifecycleVerbGate` with that one input — which is the
   * whole point. Wiring only the handlers left the buttons live off the BOUND
   * agent's deployment state in the reference prototype: selecting the
   * undeployed `rfq` kept Prod and Run enabled against `leasing`, so you could
   * be talking about B, looking at F, and deploy B.
   *
   * Every reason reaches BOTH `aria-label` and `data-tooltip`: a disabled
   * control without its reason is mute.
   */
  const gate = (verb: Parameters<typeof lifecycleVerbGate>[0]): string | null =>
    lifecycleVerbGate(verb, { subject: workflow, authenticated, deployError: lastDeployError })
      .reason;
  const prodDisabledReason = gate("prod");
  const cloudDisabledReason = gate("run");
  const effectiveTarget: RunTarget =
    preferredTarget === "prod" && cloudDisabledReason ? "local" : preferredTarget;
  const runLabel = effectiveTarget === "local" ? "Local" : "Cloud";

  const selectRunTarget = (target: RunTarget): void => {
    if (target === "prod" && cloudDisabledReason) return;
    setPreferredTarget(target);
    saveStoredRunTarget(workflow.path, target);
    setRunMenuOpen(false);
    onRequestRun(target, runMainButtonRef.current);
  };

  return (
    <div
      className="session-actions"
      data-testid="session-steps"
      aria-label="Agent actions"
      {...trackingAttrs({ surface: "agent_actions" })}
    >
      {/* One-click preview loop: the server detected a dev server this session's
          agent started — one click opens it. */}
      {preview && (
        <a
          className="status-tag status-tag-action session-preview-chip"
          data-testid="session-preview-chip"
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Preview :${preview.port}`}
          data-tooltip={`The coding agent is serving an app on port ${preview.port}. Opens ${preview.url}`}
        >
          <Icon name="ExternalLink" size={12} />
          <span className="session-preview-label">{"Preview "}</span>:{preview.port}
        </a>
      )}

      {/* Prod: the compact globe shortcut to THIS agent in the Sapiom
          dashboard. Always shown, and disabled with its reason when the subject
          has no definition to open — it used to fall back to the dashboard
          root, which reads as "your agent is over there" for an agent that has
          never been anywhere. A real `<button disabled>`, not an `aria-disabled`
          link, so the control is genuinely unclickable rather than merely
          announced as unavailable. */}
      {prodDisabledReason ? (
        <button
          className="session-step session-action-prod"
          data-testid="session-step-prod"
          type="button"
          disabled
          aria-label={`Prod: ${prodDisabledReason}`}
          data-tooltip={`Prod: ${prodDisabledReason}`}
        >
          <Icon name="Globe" size={14} />
        </button>
      ) : (
        <a
          className="session-step session-action-prod"
          data-testid="session-step-prod"
          href={agentUrl(workflow.definitionId ?? 0)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${workflow.name} in the Sapiom dashboard`}
          data-tooltip="Open this linked agent in the Sapiom dashboard"
        >
          <Icon name="Globe" size={14} />
        </a>
      )}

      <div
        className="session-run-split"
        data-running={runningTarget === effectiveTarget || undefined}
      >
        <button
          ref={runMainButtonRef}
          className={
            "session-step session-run-main" +
            (runnable ? " session-action-primary" : "")
          }
          data-testid="session-step-local"
          type="button"
          onClick={() => onRequestRun(effectiveTarget, runMainButtonRef.current)}
          aria-label={`Run using ${runLabel}`}
          data-tooltip={`Review input and run using ${runLabel}`}
        >
          <Icon name="Play" size={14} />
          <span className="session-step-label">Run · {runLabel}</span>
        </button>
        <button
          ref={runMenuButtonRef}
          className={
            "session-step session-run-menu-trigger" +
            (runnable ? " session-action-primary" : "")
          }
          type="button"
          aria-label="Choose run target"
          aria-haspopup="menu"
          aria-expanded={runMenuOpen}
          onClick={() => setRunMenuOpen((open) => !open)}
        >
          <Icon name="ChevronDown" size={13} />
        </button>
        <RunTargetMenu
          open={runMenuOpen}
          anchorRef={runMenuButtonRef}
          onDismiss={() => setRunMenuOpen(false)}
          selected={preferredTarget}
          cloudDisabledReason={cloudDisabledReason}
          onSelect={selectRunTarget}
        />
      </div>

      {actions.map((action) => {
        // Auth gate: actions requiring authentication are disabled when not
        // signed in. Test remains available because its Sapiom calls are stubbed.
        const authReason = action.needsAuth ? gate("deploy") : null;
        // A definition id is only a link. Prod Run requires a ready cloud build.
        const funnelReason = action.needsDeploy ? cloudDisabledReason : null;
        // Direct actions bypass the pty; only actual prompt injection waits for
        // the coding-agent session to become ready.
        const readyReason =
          !sessionReady && action.macro && macroNeedsReadySession(action.macro)
            ? "Session is starting"
            : null;
        const disabledReason =
          authReason ??
          funnelReason ??
          readyReason ??
          (action.macro ? macroDisabledReason(action.macro, workflow, activeSessionId) : null);
        // The run's REAL status drives this (not the hand-off pending ring), so
        // Test/Run stay lit for the whole execution the user is watching.
        const isRunningAction = false;
        return (
          <button
            key={action.id}
            className={"session-step" + (action.primary ? " session-action-primary" : "")}
            data-testid={action.testId}
            data-pending={pendingId === action.id || undefined}
            data-running={isRunningAction || undefined}
            disabled={Boolean(disabledReason)}
            data-tooltip={disabledReason ? `${action.label}: ${disabledReason}` : action.hint}
            aria-label={disabledReason ? `${action.label}: ${disabledReason}` : action.label}
            onClick={() => {
              if (!action.macro) return;
              onRunMacro(action.macro);
              setPendingId(action.id);
              track("macro.invoked", { macroId: action.macro.id });
            }}
          >
            <Icon name={action.icon} size={14} />
            <span className="session-step-label">{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}
