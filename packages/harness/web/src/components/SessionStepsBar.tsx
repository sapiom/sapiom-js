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
}

/**
 * The agent's action bar on the shared subheader row. NOT a stepper: per
 * Sapiom's own model (docs.sapiom.ai /agents) these are repeatable ACTIONS,
 * not one-way stages — you run local as often as you test, deploy as often
 * as you ship. The only durable state is "deployed" (definitionId), shown as
 * the left-anchored status chip. Actions sit right-anchored, Deploy at the
 * right edge as the primary:
 *   Local  = run_local  (test run, capabilities stubbed)
 *   Prod   = open_prod  (dashboard link; needs a deploy)
 *   Run    = prod_run   (real cloud execution; needs a deploy)
 *   Deploy = deploy     (push + cloud build)
 */
export function SessionStepsBar({
  workflow,
  activeSessionId,
  sessionReady,
  macros,
  onRunMacro,
  preview,
}: SessionStepsBarProps): JSX.Element {
  const macroFor = (id: string): MacroDef | undefined => macros.find((m) => m.id === id);
  const deployed = workflow.definitionId != null;

  // Launched-but-not-durable feedback: a clicked action shows a dotted
  // "in flight" ring until a durable signal lands (deploy flips
  // definitionId) or the binding changes. Best-effort by design.
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => {
    setPendingId(null);
  }, [workflow.path, deployed]);

  const actions: {
    id: string;
    label: string;
    icon: string;
    macro?: MacroDef;
    testId: string;
    hint: string;
    primary?: boolean;
    needsDeploy?: boolean;
  }[] = [
    {
      id: "local",
      label: "Local",
      icon: "FlaskConical",
      macro: macroFor("run_local"),
      testId: "session-step-local",
      hint: "Test: run locally with every capability stubbed - no real calls.",
    },
    {
      id: "prod",
      label: "Prod",
      // Globe, not the macro's ExternalLink: when the bar degrades to
      // icon-only (narrow center pane) the icon alone must still say
      // "the live production surface" - a bare external-link arrow reads
      // as "some link".
      icon: "Globe",
      macro: macroFor("open_prod"),
      testId: "macro-open_prod",
      hint: "Open the deployed workflow in the Sapiom dashboard.",
      needsDeploy: true,
    },
    {
      id: "run",
      label: "Run",
      icon: "Play",
      macro: macroFor("prod_run"),
      testId: "session-step-run",
      hint: "Ship: start a real cloud execution on Sapiom.",
      needsDeploy: true,
    },
    {
      id: "deploy",
      label: "Deploy",
      icon: "CloudUpload",
      macro: macroFor("deploy"),
      testId: "session-step-deploy",
      hint: "Ship: push and build on Sapiom.",
      primary: true,
    },
  ].filter((action) => action.macro);

  return (
    <div className="session-steps" data-testid="session-steps" aria-label="Agent actions">
      {/* The one durable truth, left-anchored: has this agent been deployed? */}
      <span
        className="status-tag session-lifecycle-chip"
        data-testid="session-lifecycle-chip"
        data-deployed={deployed}
        data-tooltip={
          deployed
            ? `Deployed to Sapiom (definition ${workflow.definitionId}). Run starts real cloud executions.`
            : "Draft: exists locally only. Building here uses your Claude Code account; Deploy publishes to Sapiom."
        }
      >
        <Icon name={deployed ? "Cloud" : "CloudOff"} size={13} />
        {/* display: contents at rest, hidden by the bar's container query
            below 380px — the icon + tooltip keep carrying the state. */}
        <span className="session-lifecycle-label">{deployed ? "Deployed" : "Draft"}</span>
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
          const funnelReason = action.needsDeploy && !deployed ? "Not deployed yet" : null;
          // Inject-kind actions type into the session's pty — a session that
          // is still starting (or parked on a trust prompt) would 409 the
          // click into an after-the-fact toast. Disable with the reason up
          // front; open-url actions never touch the pty and stay live.
          const readyReason =
            !sessionReady && action.macro && action.macro.action.kind !== "open-url"
              ? "Session is starting"
              : null;
          const disabledReason =
            funnelReason ??
            readyReason ??
            (action.macro ? macroDisabledReason(action.macro, workflow, activeSessionId) : null);
          const a11yLabel = action.id === "prod" && action.macro ? action.macro.label : action.label;
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
                if (action.id !== "prod") setPendingId(action.id);
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
