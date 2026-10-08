import type { JSX } from "react";

import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";

/**
 * The centre pane when there is nothing to show and no project chosen to
 * create in: a fresh install or every project removed ("No project yet"), or
 * projects in the rail with nothing open ("Nothing open"). The new-agent
 * screen is mounted only with a project (flow-creation.md §4.3), so this is
 * not that screen with the project left blank; it is the honest state before
 * it, with the one move that fills it. New project runs the folder step (§4.1).
 */
export function NoProjectHome({
  hasProjects = false,
  onNewProject,
  firstRun = false,
  telemetryOptIn = false,
  onToggleTelemetry,
}: {
  /** Projects are in the rail but none is open: say that, not "no project". */
  hasProjects?: boolean;
  onNewProject: () => void;
  /** A fresh install: the telemetry choice is offered here, before any project. */
  firstRun?: boolean;
  telemetryOptIn?: boolean;
  onToggleTelemetry?: (next: boolean) => Promise<void>;
}): JSX.Element {
  return (
    <div
      className="composer-home no-project-home"
      data-testid={hasProjects ? "no-selection-home" : "no-project-home"}
    >
      <EmptyState
        className="terminal-empty"
        icon="FolderPlus"
        title={hasProjects ? "Nothing open" : "No project yet"}
        body={
          hasProjects
            ? "Pick a project in the rail, or start a new one. Describing the agent comes next."
            : "An agent lives in a project. Pick the folder first. Describing the agent comes next."
        }
        cta={
          <button
            type="button"
            className="btn-primary"
            data-testid="home-new-project"
            onClick={onNewProject}
          >
            <Icon name="Plus" size={14} /> New project
          </button>
        }
      />
      {firstRun && onToggleTelemetry && (
        <div className="composer-footer">
          <label className="composer-consent" data-testid="welcome-consent">
            <button
              type="button"
              role="switch"
              aria-checked={telemetryOptIn}
              data-testid="welcome-telemetry-toggle"
              className={"toggle-switch" + (telemetryOptIn ? " is-on" : "")}
              onClick={() => void onToggleTelemetry(!telemetryOptIn)}
            >
              <span className="toggle-knob" />
            </button>
            <span className="composer-consent-copy">
              Help us improve Agent Studio: share your session details with Sapiom. Off by
              default; change it anytime in Settings.
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
