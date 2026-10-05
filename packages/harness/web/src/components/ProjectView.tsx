import type { JSX } from "react";
import type { AppState, HarnessSession, WorkflowInfo } from "@shared/types";

import { AgentMapPane } from "./AgentMapPane";
import { CanvasPane } from "./CanvasPane";
import {
  ProjectView as ProjectViewFrame,
  projectMapMode,
  type ProjectMapMode,
} from "./CentrePane";
import { EmptyState } from "./EmptyState";
import { MapAgentPanel } from "./MapAgentPanel";
import { ProjectAgentGrid } from "./ProjectAgentGrid";
import { createApi } from "../lib/api";
import type { GraphViewportStore } from "../lib/graph-viewport";
import { shownProjectId, type Centre } from "../lib/centre-pane";
import { basenameOf, samePath } from "../lib/paths";
import { sessionsForAgent, type SessionMark } from "../lib/rail-sessions";
import { canvasSourceFor } from "../lib/session-scope";
import type { ShellProjects } from "../lib/shell-projects";
import type { AgentVerbs } from "../lib/use-agent-verbs";
import type { useAgentMapEntry } from "../lib/use-agent-map-entry";
import type { HarnessStateHook } from "../lib/use-harness-state";
import type { ProjectActions } from "../lib/use-project-actions";
import type { SessionActions } from "../lib/use-session-actions";

/**
 * The one API client the project view reaches for directly.
 *
 * `use-harness-state` exposes every other call as a prop; the workflow-keyed
 * canvas board (IA-01) is read here instead because that hook is owned by
 * another slice of the rail rebuild this week. It belongs beside
 * `getWorkflowInputContract` in the store and should move there — module-level
 * like `use-account-plan`'s, so mock mode still holds ONE fixture instance.
 */
const shellApi = createApi();

/**
 * What the project view needs from the shell before it renders: whether it
 * draws the map pane or the agent cards, and the header the session bar shows
 * in its place (the project, the entered agent, Back to map, New agent, and
 * the map's full view while a drawn map is ready).
 */
export function projectViewChrome({
  centre,
  state,
  projects,
  agentMapEntry,
  projectActions,
  onExpandMap,
}: {
  centre: Centre;
  state: AppState;
  projects: ShellProjects;
  agentMapEntry: ReturnType<typeof useAgentMapEntry>;
  projectActions: ProjectActions;
  onExpandMap: () => void;
}) {
  const shownProject = shownProjectId(centre);
  const shownScope = shownProject ? projects.projectScope(shownProject) : null;
  const mapMode =
    centre.kind === "project-map"
      ? projectMapMode({
          state: agentMapEntry.state.workspace,
          unavailable: agentMapEntry.state.unavailable,
          durable:
            state.studioProjects?.some(
              (project) => project.projectId === centre.projectId,
            ) ?? false,
          initialization: agentMapEntry.initialization,
        })
      : null;
  const mapAgentName =
    centre.kind === "agent-canvas"
      ? (state.workflows.find((workflow) => samePath(workflow.path, centre.path))
          ?.name ?? basenameOf(centre.path))
      : null;
  const header =
    shownProject && shownScope
      ? {
          label: projects.projectLabelOf(shownProject),
          agentName: mapAgentName,
          onBackToMap: () => projectActions.backToMap(shownProject),
          onNewAgent: () =>
            projectActions.handleCreateAgentInProject(
              shownScope.cwd,
              projects.projectLabelOf(shownProject),
            ),
          onExpandMap:
            mapMode?.kind === "map" &&
            agentMapEntry.state.workspace.status === "ready"
              ? onExpandMap
              : null,
        }
      : null;
  return { mapMode, header };
}

/**
 * THE PROJECT VIEW (flow-navigation.md 4.3): the project's Agent Map at full
 * centre width, nothing beside it, or the canvas of an agent entered from it.
 * Click an agent for its panel, floating over the map (4.4); double click, or
 * the panel's Open canvas, enters the agent's canvas in this same centre.
 */
export function ProjectView({
  harness,
  state,
  projectId,
  agentPath,
  mapMode,
  agentMapEntry,
  viewportStore,
  agentsInProject,
  mapExpanded,
  onToggleMapExpanded,
  mapPanelPath,
  onPickAgent,
  onClosePanel,
  onOpenAgentCanvas,
  hiddenSessionIds,
  now,
  sessionLabel,
  markOf,
  sessions,
  verbs,
}: {
  harness: HarnessStateHook;
  state: AppState;
  projectId: string;
  /** The agent whose canvas is entered, or null for the map. */
  agentPath: string | null;
  mapMode: ProjectMapMode | null;
  agentMapEntry: ReturnType<typeof useAgentMapEntry>;
  viewportStore: GraphViewportStore;
  agentsInProject: (projectId: string) => WorkflowInfo[];
  mapExpanded: boolean;
  onToggleMapExpanded: () => void;
  /** The agent whose panel is open on the map, by path (flow 4.4). */
  mapPanelPath: string | null;
  onPickAgent: (path: string) => void;
  onClosePanel: () => void;
  onOpenAgentCanvas: (projectId: string, path: string) => void;
  hiddenSessionIds: ReadonlySet<string>;
  now: number;
  sessionLabel: (session: HarnessSession) => string;
  markOf: (session: HarnessSession) => SessionMark;
  sessions: SessionActions;
  verbs: AgentVerbs;
}): JSX.Element {
  /** The agent panel on the map, one recipe for the drawn map and the agent
   *  cards, so the two can never offer different verbs. */
  const renderAgentPanel = (): JSX.Element | null => {
    const agent = mapPanelPath
      ? state.workflows.find((workflow) => samePath(workflow.path, mapPanelPath))
      : undefined;
    if (!agent) return null;
    return (
      <MapAgentPanel
        agent={agent}
        sessions={sessionsForAgent(
          state.sessions,
          projectId,
          agent.path,
          hiddenSessionIds,
          now,
        )}
        sessionLabel={sessionLabel}
        markOf={markOf}
        now={now}
        onOpenSession={sessions.openSession}
        onStartChat={() => sessions.handleStartChat(agent, projectId)}
        startChatPending={sessions.startChatPending}
        onEnterCanvas={() => onOpenAgentCanvas(projectId, agent.path)}
        onChangeLocation={(to) => void verbs.handleMoveAgent(agent.path, to)}
        validateLocation={(to) => verbs.locationRefusal(agent.path, to)}
        onClose={onClosePanel}
      />
    );
  };

  if (agentPath === null) {
    /* Keyed by project, so switching projects is a fresh load rather than a
       mutation of the one on screen. */
    return (
      <ProjectViewFrame showing="map">
        {mapMode?.kind === "map" ? (
          <AgentMapPane
            key={`${projectId}:${harness.authRevision}`}
            viewportStore={viewportStore}
            visible
            api={harness.api}
            workflows={state.workflows}
            refreshWorkflows={harness.refreshWorkflows}
            onPickAgent={(workflow) => onPickAgent(workflow.path)}
            onEnterAgent={(workflow) =>
              onOpenAgentCanvas(projectId, workflow.path)
            }
            agentPanel={renderAgentPanel()}
            state={agentMapEntry.state.workspace}
            unavailable={agentMapEntry.state.unavailable}
            onRetry={agentMapEntry.retryWorkspace}
            initialization={agentMapEntry.initialization}
            onRetryGeneration={agentMapEntry.retryGeneration}
            expanded={mapExpanded}
            onToggleExpanded={onToggleMapExpanded}
          />
        ) : (
          <ProjectAgentGrid
            agents={agentsInProject(projectId)}
            map={mapMode?.kind === "cards" ? mapMode.map : "not-drawn"}
            onRetryGeneration={
              agentMapEntry.initialization?.status === "failed" &&
              agentMapEntry.initialization.retryable
                ? agentMapEntry.retryGeneration
                : null
            }
            selectedPath={mapPanelPath}
            onPick={(agent) => onPickAgent(agent.path)}
            onEnter={(agent) => onOpenAgentCanvas(projectId, agent.path)}
            panel={renderAgentPanel()}
          />
        )}
      </ProjectViewFrame>
    );
  }

  const mapAgent =
    state.workflows.find((workflow) => samePath(workflow.path, agentPath)) ??
    null;
  return (
    <ProjectViewFrame showing="agent">
      {mapAgent ? (
        /* The agent's own canvas, entered from the map. Served by
           the workflow-keyed route (IA-01): it is a look at the
           agent, not at a session, so no session is bound or
           started for it. */
        <CanvasPane
          key={`agent:${mapAgent.path}`}
          sessionId={null}
          lastMessage={harness.lastMessage}
          subjectWorkflow={mapAgent}
          source={canvasSourceFor({
            subjectPath: mapAgent.path,
            bindingPath: null,
            sessionId: null,
          })}
          loadWorkflowGraph={shellApi.getWorkflowGraph.bind(shellApi)}
          overviewActive={false}
          sessionExited={false}
          expanded={false}
          onToggleExpanded={() => {}}
          macros={state.macros}
          tasks={harness.tasks}
          surface="board"
          onOpenSteps={() => {}}
          run={null}
          runTarget={null}
          runs={[]}
          onSelectRun={() => {}}
          preview={null}
          deployState={harness.deployStateByPath.get(mapAgent.path) ?? null}
          onDismissDeploy={() => harness.dismissDeployState(mapAgent.path)}
          agentsBaseUrl={state.agentsBaseUrl}
          onOpenCode={() => {}}
          workflows={state.workflows}
          onOpenWorkflow={(path) => onOpenAgentCanvas(projectId, path)}
          onRunMacro={(macro) => verbs.handleRunMacroForWorkflow(mapAgent, macro)}
          onInjectPrompt={() => {}}
          onDescribeWorkflow={verbs.handleDescribeWithAI}
        />
      ) : (
        <EmptyState
          className="canvas-empty"
          testId="project-agent-missing"
          icon="Folder"
          title="This agent is no longer here"
          body="It moved or was removed. Go back to the map to see the project's agents."
        />
      )}
    </ProjectViewFrame>
  );
}
