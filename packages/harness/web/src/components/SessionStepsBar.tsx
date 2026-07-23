import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { MacroDef, WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { macroDisabledReason } from "../lib/macro-gating";
import { track } from "../lib/track";

interface SessionStepsBarProps {
  workflow: WorkflowInfo;
  activeSessionId: string | null;
  /** The active session is live and accepting input. */
  sessionReady: boolean;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef) => void;
  /** Dev server the agent started in this session (port.detected), if any. */
  preview: { port: number; url: string } | null;
  /**
   * Error message from the last failed deploy for this workflow, or null when
   * the last deploy succeeded (or no deploy has run). Persists after toast
   * dismissal so the disabled-reason stays accurate.
   */
  lastDeployError: string | null;
  /**
   * Whether the user is currently authenticated. When false, auth-requiring
   * actions are disabled with an explicit "Connect your account first" reason
   * so the user knows exactly what to do — no silent dead-click.
   */
  authenticated: boolean;
  /**
   * Monotonic counter bumped by the parent on every direct-action settle
   * (deploy or run, success or failure). Adding this to the pending-ring
   * useEffect deps guarantees the ring always clears on settle, even for
   * re-deploys of an already-deployed workflow where `deployed` stays true
   * and `lastDeployError` stays null (so neither dep would flip otherwise).
   */
  directActionSettleSeq: number;
}

/**
 * The agent's action bar on the shared subheader row. NOT a stepper: per
 * Sapiom's own model (docs.sapiom.ai /agents) these are repeatable ACTIONS,
 * not one-way stages — you run local as often as you test, deploy as often
 * as you ship. The only durable state is "deployed" (definitionId), shown as
 * the left-anchored status chip. Actions sit right-anchored, Deploy at the
 * right edge as the primary:
 *   Local Run = run_local  (test run, capabilities stubbed)
 *   Prod Run  = prod_run   (real cloud execution; needs a deploy)
 *   Deploy    = deploy     (push + cloud build)
 *
 * The "Go to dashboard" affordance (open_prod equivalent) lives in the canvas
 * header's WorkflowActionsHeader when a definitionId is set.
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

  // Launched-but-not-durable feedback: a clicked action shows a dotted
  // "in flight" ring until a durable signal lands. The ring clears on ANY
  // terminal outcome — success OR failure — by including all relevant settled
  // state in the useEffect deps:
  //   - workflow.path: re-binding a session clears the pending id.
  //   - deployed: a first-time deploy succeeds and flips definitionId.
  //   - lastDeployError: a failed deploy sets this; ring must not persist.
  //   - directActionSettleSeq: bumped by the parent on EVERY direct-action
  //     settle (success or failure), covering the cases where deployed and
  //     lastDeployError don't change (e.g. re-deploy of an already-deployed
  //     workflow, or a prod/local run completing without a re-bind).
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
      label: "Local Run",
      icon: "FlaskConical",
      macro: macroFor("run_local"),
      testId: "session-step-local",
      hint: "Test: run locally with every capability stubbed - no real calls.",
    },
    {
      id: "run",
      label: "Prod Run",
      icon: "Play",
      macro: macroFor("prod_run"),
      testId: "session-step-run",
      hint: "Ship: start a real cloud execution on Sapiom.",
      needsDeploy: true,
      needsAuth: true,
    },
    {
      id: "deploy",
      label: "Deploy",
      icon: "CloudUpload",
      macro: macroFor("deploy"),
      testId: "session-step-deploy",
      hint: "Ship: push and build on Sapiom.",
      primary: true,
      needsAuth: true,
    },
  ].filter((action) => action.macro);

  return (
    <div className="session-steps" data-testid="session-steps" aria-label="Agent actions">
      {/* The one durable truth, left-anchored: has this agent been deployed? */}
      <span
        className="status-tag session-lifecycle-chip"
        data-testid="session-lifecycle-chip"
        data-deployed={deployed}
        data-deploy-error={lastDeployError != null && !deployed ? "" : undefined}
        data-tooltip={
          deployed
            ? `Deployed to Sapiom (definition ${workflow.definitionId}). Run starts real cloud executions.`
            : lastDeployError != null
              ? "Last deploy failed. Retry Deploy to push to Sapiom."
              : "Draft: exists locally only. Building here uses your Claude Code account; Deploy publishes to Sapiom."
        }
      >
        <Icon name={deployed ? "Cloud" : "CloudOff"} size={13} />
        {/* display: contents at rest, hidden by the bar's container query
            below 380px — the icon + tooltip keep carrying the state. */}
        <span className="session-lifecycle-label">
          {deployed ? "Deployed" : lastDeployError != null ? "Deploy failed" : "Draft"}
        </span>
      </span>

      {/* One-click preview loop, v0: the server detected a dev
          server this session's agent started - one click opens the app. */}
      {preview && (
        <a
          className="status-tag status-tag-action session-preview-chip"
          data-testid="session-preview-chip"
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Preview :${preview.port}`}
          data-tooltip={`The agent is serving an app on port ${preview.port}. Opens ${preview.url}`}
        >
          <Icon name="ExternalLink" size={12} />
          {/* Below 380px only the word hides; the port stays as the chip's
              compact identity. */}
          <span className="session-preview-label">{"Preview "}</span>:{preview.port}
        </a>
      )}

      <div className="session-actions">
        {actions.map((action) => {
          // Auth gate: actions requiring authentication are disabled when not
          // signed in — never a silent dead-click. Local Run (no needsAuth) is
          // always available since it is fully offline.
          const authReason =
            action.needsAuth && !authenticated ? "Connect your account first" : null;
          // Deploy-gate: prod-run needs a definitionId. Surface "Last deploy
          // failed" (distinct from the virgin "Not deployed yet") when we know
          // the user has already tried and it broke — points to the right fix.
          const funnelReason =
            action.needsDeploy && !deployed
              ? lastDeployError != null
                ? "Last deploy failed — retry Deploy"
                : "Not deployed yet"
              : null;
          // Inject-kind actions type into the session's pty — a session that
          // is still starting (or parked on a trust prompt) would 409 the
          // click into an after-the-fact toast. Disable with the reason up
          // front; open-url actions never touch the pty and stay live.
          const readyReason =
            !sessionReady && action.macro && action.macro.action.kind !== "open-url"
              ? "Session is starting"
              : null;
          const disabledReason =
            authReason ??
            funnelReason ??
            readyReason ??
            (action.macro ? macroDisabledReason(action.macro, workflow, activeSessionId) : null);
          const a11yLabel = action.label;
          return (
            <button
              key={action.id}
              className={"session-step" + (action.primary ? " session-action-primary" : "")}
              data-testid={action.testId}
              data-pending={pendingId === action.id || undefined}
              disabled={Boolean(disabledReason)}
              data-tooltip={disabledReason ? `${a11yLabel}: ${disabledReason}` : action.hint}
              aria-label={disabledReason ? `${a11yLabel}: ${disabledReason}` : a11yLabel}
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
    </div>
  );
}
