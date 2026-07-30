/**
 * DeploymentPopover — shows deployment status details when the user clicks the
 * session lifecycle chip (Deployed / Draft / Deploy failed).
 *
 * Three states:
 *   Deployed  (definitionId != null) — heading, definition id, last build info,
 *             "Open in dashboard" link, and a "Redeploy" button.
 *   Draft     (no definitionId, no error) — "Not deployed yet" + "Deploy" button.
 *   Error     (no definitionId, lastDeployError set) — error hint + "Retry" button.
 *
 * Positioned by AnchoredPopover (outside-click + Escape dismiss handled there).
 * Design tokens only — no raw hex values.
 */
import type { JSX, RefObject } from "react";

import { loadLastDeploy, relativeTime } from "../lib/deploy-meta";
import type { WorkflowInfo } from "@shared/types";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";

interface DeploymentPopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  workflow: WorkflowInfo;
  lastDeployError: string | null;
  /** Fires when the user clicks Deploy / Redeploy / Retry — delegates to the
   *  existing deploy action in SessionStepsBar's parent. */
  onDeploy: () => void;
}

export function DeploymentPopover({
  open,
  anchorRef,
  onDismiss,
  workflow,
  lastDeployError,
  onDeploy,
}: DeploymentPopoverProps): JSX.Element | null {
  const deployed = workflow.definitionId != null;
  const meta = open && deployed ? loadLastDeploy(workflow.path) : null;

  const handleDeploy = (): void => {
    onDismiss();
    onDeploy();
  };

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onDismiss={onDismiss}
      placement="down-start"
      className="deployment-popover"
      role="dialog"
      testid="deployment-popover"
    >
      {deployed ? (
        /* ── Deployed state ─────────────────────────────────────────────── */
        <div className="deployment-popover-body">
          <div className="deployment-popover-heading">
            <Icon name="Cloud" size={13} />
            <span>Deployed to production</span>
          </div>

          <dl className="deployment-popover-details">
            <div className="deployment-popover-row">
              <dt className="deployment-popover-label">Definition</dt>
              <dd className="deployment-popover-value">#{workflow.definitionId}</dd>
            </div>
            {meta && (
              <div className="deployment-popover-row">
                <dt className="deployment-popover-label">Build</dt>
                <dd className="deployment-popover-value deployment-popover-meta">
                  {meta.buildRunId}
                  {" · "}
                  {relativeTime(meta.deployedAt)}
                </dd>
              </div>
            )}
          </dl>

          <div className="deployment-popover-actions">
            <a
              className="deployment-popover-link"
              href={`https://app.sapiom.ai/workflows/${workflow.definitionId}`}
              target="_blank"
              rel="noreferrer"
              data-testid="deployment-popover-dashboard-link"
            >
              <Icon name="ExternalLink" size={12} />
              Open in dashboard
            </a>
            <button
              type="button"
              className="btn-primary deployment-popover-btn"
              data-testid="deployment-popover-redeploy"
              onClick={handleDeploy}
            >
              <Icon name="CloudUpload" size={13} />
              Redeploy
            </button>
          </div>
        </div>
      ) : lastDeployError != null ? (
        /* ── Deploy-failed state ────────────────────────────────────────── */
        <div className="deployment-popover-body">
          <div className="deployment-popover-heading deployment-popover-heading--error">
            <Icon name="TriangleAlert" size={13} />
            <span>Last deploy failed</span>
          </div>
          <p className="deployment-popover-hint">{lastDeployError}</p>
          <div className="deployment-popover-actions">
            <button
              type="button"
              className="btn-primary deployment-popover-btn"
              data-testid="deployment-popover-retry"
              onClick={handleDeploy}
            >
              <Icon name="CloudUpload" size={13} />
              Retry deploy
            </button>
          </div>
        </div>
      ) : (
        /* ── Draft state ────────────────────────────────────────────────── */
        <div className="deployment-popover-body">
          <div className="deployment-popover-heading">
            <Icon name="CloudOff" size={13} />
            <span>Not deployed yet</span>
          </div>
          <p className="deployment-popover-hint">
            Deploy publishes this agent to Sapiom.
          </p>
          <div className="deployment-popover-actions">
            <button
              type="button"
              className="btn-primary deployment-popover-btn"
              data-testid="deployment-popover-deploy"
              onClick={handleDeploy}
            >
              <Icon name="CloudUpload" size={13} />
              Deploy
            </button>
          </div>
        </div>
      )}
    </AnchoredPopover>
  );
}
