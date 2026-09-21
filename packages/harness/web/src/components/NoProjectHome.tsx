import type { JSX } from "react";

import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";

/**
 * The centre pane when there is nothing to show and no project to create in:
 * a fresh install, or every project removed. The new-agent screen is mounted
 * only with a project (flow-creation.md §4.3), so this is not that screen
 * with the project left blank; it is the honest state before it, with the one
 * move that fills it. New project runs the folder step (§4.1).
 */
export function NoProjectHome({
  onNewProject,
}: {
  onNewProject: () => void;
}): JSX.Element {
  return (
    <div className="composer-home no-project-home" data-testid="no-project-home">
      <EmptyState
        className="terminal-empty"
        icon="FolderPlus"
        title="No project yet"
        body="An agent lives in a project. Pick the folder first. Describing the agent comes next."
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
    </div>
  );
}
