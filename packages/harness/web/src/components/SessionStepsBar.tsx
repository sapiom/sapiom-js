import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { macroNeedsReadySession } from "../lib/macro-actions";
import { macroDisabledReason } from "../lib/macro-gating";
import { track } from "../lib/track";
import { SAPIOM_DASHBOARD_ROOT, agentUrl } from "../lib/urls";
import {
  prodRunDisabledReason,
  workflowDeploymentState,
} from "../lib/workflow-deployment";

interface SessionStepsBarProps {
  workflow: WorkflowInfo;
  activeSessionId: string | null;
  /** The active session is live and accepting input. */
  sessionReady: boolean;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef) => void;
  /** Dev server the agent started in this session (port.detected), if any. */
  preview: { port: number; url: string } | null;
  /** Error message from the last failed deploy for this workflow, or null. */
  lastDeployError: string | null;
  /** Whether the user is authenticated (gates auth-requiring actions). */
  authenticated: boolean;
  /** Bumped by the parent on every direct-action settle, so the pending ring
   *  always clears even when neither deployment state nor `lastDeployError` flips. */
  directActionSettleSeq: number;
}

/**
 * The agent's action cluster, right-anchored inside the single session bar (no
 * longer its own row). Per Sapiom's model these are repeatable ACTIONS, not
 * one-way stages. Order is fixed at every width: Prod globe → Test → Run →
 * Deploy.
 *   Prod (globe) = open the agent in the Sapiom dashboard (deep-link when
 *                  linked, dashboard root otherwise)
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
  preview,
  lastDeployError,
  authenticated,
  directActionSettleSeq,
}: SessionStepsBarProps): JSX.Element {
  const macroFor = (id: string): MacroDef | undefined => macros.find((m) => m.id === id);
  const deploymentState = workflowDeploymentState(workflow, lastDeployError);
  const runnable = deploymentState === "ready";
  // A linked agent deep-links to its definition; a draft (or signed-out)
  // agent has no definition yet, so the globe falls back to the dashboard root
  // — always a real destination, never a dead click.
  const dashboardUrl =
    workflow.definitionId != null ? agentUrl(workflow.definitionId) : SAPIOM_DASHBOARD_ROOT;

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
  useEffect(() => {
    setPendingId(null);
  }, [workflow.path, deploymentState, lastDeployError, directActionSettleSeq]);

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
      id: "local",
      label: "Test",
      icon: "FlaskConical",
      macro: macroFor("run_local"),
      testId: "session-step-local",
      hint: "Test locally with Sapiom capability calls stubbed — no real Sapiom capability calls.",
    },
    {
      id: "run",
      label: "Run",
      icon: "Play",
      macro: macroFor("prod_run"),
      testId: "session-step-run",
      hint: "Run: start a real cloud execution on Sapiom.",
      needsDeploy: true,
      needsAuth: true,
      // Ready build → Run is primary (the agent is live; running it is the act).
      primary: runnable,
    },
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

  return (
    <div className="session-actions" data-testid="session-steps" aria-label="Agent actions">
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

      {/* Prod: the compact globe shortcut to the Sapiom dashboard. Always shown. */}
      <a
        className="session-step session-action-prod"
        data-testid="session-step-prod"
        href={dashboardUrl}
        target="_blank"
        rel="noreferrer"
        aria-label="Open this agent in the Sapiom dashboard"
        data-tooltip={
          workflow.definitionId != null
            ? "Open this linked agent in the Sapiom dashboard"
            : "Open the Sapiom dashboard"
        }
      >
        <Icon name="Globe" size={14} />
      </a>

      {actions.map((action) => {
        // Auth gate: actions requiring authentication are disabled when not
        // signed in. Test remains available because its Sapiom calls are stubbed.
        const authReason =
          action.needsAuth && !authenticated ? "Connect your account first" : null;
        // A definition id is only a link. Prod Run requires a ready cloud build.
        const funnelReason = action.needsDeploy
          ? prodRunDisabledReason(workflow, lastDeployError)
          : null;
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
        return (
          <button
            key={action.id}
            className={"session-step" + (action.primary ? " session-action-primary" : "")}
            data-testid={action.testId}
            data-pending={pendingId === action.id || undefined}
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
