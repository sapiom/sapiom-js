import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { macroDisabledReason } from "../lib/macro-gating";
import { track } from "../lib/track";
import { SAPIOM_DASHBOARD_ROOT, agentUrl } from "../lib/urls";

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
   *  always clears even when neither `deployed` nor `lastDeployError` flips. */
  directActionSettleSeq: number;
}

/**
 * The agent's action cluster, right-anchored inside the single session bar (no
 * longer its own row). Per Sapiom's model these are repeatable ACTIONS, not
 * one-way stages. Order is fixed at every width: Prod globe → Test → Run →
 * Deploy.
 *   Prod (globe) = open the agent in the Sapiom dashboard (deep-link when
 *                  deployed, dashboard root otherwise)
 *   Test         = run_local  (offline stub run; no auth)
 *   Run          = prod_run   (real cloud execution; needs deploy + auth)
 *   Deploy       = deploy     (push + cloud build; needs auth)
 *
 * The filled CTA follows state: a Draft fills Deploy, a Deployed agent fills
 * Run; idle verbs stay outlined. The Draft/Deployed lifecycle pill is NOT here
 * — it lives once in the right-pane header, so the bar carries no duplicate.
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
  const deployed = workflow.definitionId != null;
  // A deployed agent deep-links to its definition; a draft (or signed-out)
  // agent has no definition yet, so the globe falls back to the dashboard root
  // — always a real destination, never a dead click.
  const dashboardUrl =
    workflow.definitionId != null ? agentUrl(workflow.definitionId) : SAPIOM_DASHBOARD_ROOT;

  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => {
    setPendingId(null);
  }, [workflow.path, deployed, lastDeployError, directActionSettleSeq]);

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
      hint: "Test: run locally with every capability stubbed — no real calls.",
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
      // Deployed → Run is the primary CTA (the agent is live; running it is the act).
      primary: deployed,
    },
    {
      id: "deploy",
      label: "Deploy",
      icon: "CloudUpload",
      macro: macroFor("deploy"),
      testId: "session-step-deploy",
      hint: "Deploy: push and build on Sapiom.",
      needsAuth: true,
      // Draft → Deploy is the primary CTA (shipping it is the next act).
      primary: !deployed,
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
          deployed
            ? "Open this deployed agent in the Sapiom dashboard"
            : "Open the Sapiom dashboard"
        }
      >
        <Icon name="Globe" size={14} />
      </a>

      {actions.map((action) => {
        const authReason = action.needsAuth && !authenticated ? "Connect your account first" : null;
        const funnelReason =
          action.needsDeploy && !deployed
            ? lastDeployError != null
              ? "Last deploy failed — retry Deploy"
              : "Not deployed yet"
            : null;
        const readyReason =
          !sessionReady && action.macro && action.macro.action.kind !== "open-url"
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
