import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { AppState, WorkflowInfo } from "@shared/types";

import { AgentMapPane, type MapNodePick } from "./AgentMapPane";
import { AgentModal } from "./AgentModal";
import {
  ProjectView as ProjectViewFrame,
  projectMapMode,
  type ProjectMapMode,
} from "./CentrePane";
import { HandoffContext, type HandoffActions } from "./HandoffCard";
import { MapCard } from "./MapCard";
import { OpenCodeChat, type MapChatSurface } from "./OpenCodeChat";
import { ProjectAgentGrid } from "./ProjectAgentGrid";
import { errorMessage } from "../lib/api";
import { DIALOG_LAYER_SELECTOR } from "../lib/dialog-focus";
import { revealAgentFolder, revealLabel } from "../lib/desktop";
import type { GraphViewportStore } from "../lib/graph-viewport";
import { shownProjectId, type Centre } from "../lib/centre-pane";
import {
  askKindForNode,
  askPrompt,
  parseAskPrompt,
  type AskSubject,
} from "../lib/map-ask";
import {
  mapChatHostKey,
  mapChatTranscript,
  openInSessionPrompt,
} from "../lib/map-chat-host";
import { samePath } from "../lib/paths";
import { projectIdForAgent, type ShellProjects } from "../lib/shell-projects";
import type { AgentVerbs } from "../lib/use-agent-verbs";
import type { useAgentMapEntry } from "../lib/use-agent-map-entry";
import type { HarnessStateHook } from "../lib/use-harness-state";
import type { MapChatState } from "../lib/use-map-chat";
import type { ProjectActions } from "../lib/use-project-actions";
import type { LocalPreview } from "../lib/use-project-app-links";
import type { SessionActions } from "../lib/use-session-actions";
import type { OpenCodeTurnMessage } from "../../../src/shared/opencode-turn";
import "../styles/map-chat.css";

/**
 * What the project view needs from the shell before it renders: whether it
 * draws the map pane or the agent cards, and the header the session bar shows
 * in its place (the project, its App Links, New agent, and the map's full
 * view while a drawn map is ready).
 */
export function projectViewChrome({
  centre,
  state,
  projects,
  agentMapEntry,
  projectActions,
  previewBySession,
}: {
  centre: Centre;
  state: AppState;
  projects: ShellProjects;
  agentMapEntry: ReturnType<typeof useAgentMapEntry>;
  projectActions: ProjectActions;
  /** Dev servers detected per session (`port.detected`). */
  previewBySession: ReadonlyMap<string, LocalPreview>;
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
  // A locally running app is an App Link that is not deployed (4.7.3): the
  // dev servers this project's LIVE sessions started. An exited session's
  // server died with it.
  const previews =
    shownProject && shownScope
      ? state.sessions.flatMap((session) => {
          const preview = previewBySession.get(session.id);
          return preview &&
            session.status !== "exited" &&
            samePath(projects.sessionRoot(session), shownScope.cwd)
            ? [preview]
            : [];
        })
      : [];
  const header =
    shownProject && shownScope
      ? {
          label: projects.projectLabelOf(shownProject),
          appLinks: {
            agents: projects.agentsInProject(shownProject),
            previews,
            authenticated: state.authenticated === true,
          },
          onNewAgent: () =>
            projectActions.handleCreateAgentInProject(
              shownScope.cwd,
              projects.projectLabelOf(shownProject),
            ),
        }
      : null;
  return { mapMode, header };
}

/** UTF-8 text as a base64 `data:` URL, the shape `initialAttachments` takes. */
function markdownDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:text/markdown;base64,${btoa(binary)}`;
}

/**
 * THE PROJECT VIEW (flow-map-chat-overlay.md 4.1 to 4.3, 4.2b): the project's
 * Agent Map at full centre width with the floating card over it, and an
 * agent's modal over both when one is open.
 *
 * Everything that floats here is out of the map's flow, so the board's width
 * never changes (I1). The map, its pick and its map chat stay mounted under
 * the modal, so closing it returns to exactly that state (I9). A hand-off
 * makes a session and stays here (I6).
 */
export function ProjectView({
  harness,
  state,
  projectId,
  projectLabel,
  projectRoot,
  agentPath,
  mapMode,
  agentMapEntry,
  viewportStore,
  agentsInProject,
  mapPanelPath,
  onPickAgent,
  onClosePanel,
  onOpenAgent,
  onCloseAgent,
  mapChat,
  onSignIn,
  onOpenSettings,
  sessions,
  verbs,
}: {
  harness: HarnessStateHook;
  state: AppState;
  projectId: string;
  projectLabel: string;
  projectRoot: string;
  /** The agent whose modal is open over the map, or null. */
  agentPath: string | null;
  mapMode: ProjectMapMode | null;
  agentMapEntry: ReturnType<typeof useAgentMapEntry>;
  viewportStore: GraphViewportStore;
  agentsInProject: (projectId: string) => WorkflowInfo[];
  /** The agent picked on the map, by path: the card names it (4.2). */
  mapPanelPath: string | null;
  onPickAgent: (path: string) => void;
  onClosePanel: () => void;
  /** Open agent, a double click: the modal over this map (4.2b). */
  onOpenAgent: (projectId: string, path: string) => void;
  /** ×, Escape or the scrim on the modal: back to this map as it was. */
  onCloseAgent: (projectId: string) => void;
  mapChat: MapChatState;
  onSignIn: () => void;
  onOpenSettings: () => void;
  sessions: SessionActions;
  verbs: AgentVerbs;
}): JSX.Element {
  // A picked node that is not an agent (a resource, a step, a group). The
  // agent pick is the shell's (`mapPanelPath`), so the rail and the finder can
  // set it; this one only the map makes.
  const [nodePick, setNodePick] = useState<MapNodePick | null>(null);
  useEffect(() => setNodePick(null), [projectId]);

  const pickedAgent = useMemo(() => {
    if (!mapPanelPath) return null;
    const agent = state.workflows.find((workflow) =>
      samePath(workflow.path, mapPanelPath),
    );
    return agent && projectIdForAgent(agent.path, state) === projectId
      ? agent
      : null;
  }, [mapPanelPath, projectId, state]);

  const subject: AskSubject = nodePick
    ? {
        name: nodePick.name,
        kind: askKindForNode(
          nodePick.kind,
          nodePick.kind === "agent" || nodePick.kind === "subagent",
        ),
        path: `${projectRoot}#${nodePick.id}`,
      }
    : pickedAgent
      ? { name: pickedAgent.name, kind: "agent", path: pickedAgent.path }
      : { name: projectLabel, kind: "project", path: projectRoot };
  // Read when a message is sent, so a pick mid-chat moves the next chip.
  const subjectRef = useRef(subject);
  subjectRef.current = subject;

  const chatOpen = mapChat.isOpen(projectId);
  const modalAgent = agentPath
    ? (state.workflows.find((workflow) => samePath(workflow.path, agentPath)) ??
      null)
    : null;

  // An agent that moved or was removed while its modal was open: back to
  // the map rather than a modal about nothing.
  useEffect(() => {
    if (agentPath && !modalAgent && state.workflows.length > 0)
      onCloseAgent(projectId);
  }, [agentPath, modalAgent, onCloseAgent, projectId, state.workflows.length]);

  const clearPick = useCallback((): void => {
    setNodePick(null);
    onClosePanel();
  }, [onClosePanel]);

  // Escape unwinds the card one layer per press: the map chat closes back to
  // the card, then the pick returns the card to the project (4.2.5, 4.3.3).
  // Not while the modal or any other dialog is up: Escape is theirs.
  const picked = nodePick != null || pickedAgent != null;
  useEffect(() => {
    if (agentPath) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(DIALOG_LAYER_SELECTOR)) return;
      if (chatOpen) {
        event.preventDefault();
        mapChat.setOpen(projectId, false);
      } else if (picked) {
        event.preventDefault();
        clearPick();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [agentPath, chatOpen, picked, clearPick, mapChat, projectId]);

  /** The map chat's history, read straight from its host (P2's proxy). */
  const loadMapChat = async (): Promise<OpenCodeTurnMessage[]> => {
    const base = `/opencode/${encodeURIComponent(mapChatHostKey(projectId))}`;
    const headers = { "X-Harness-Token": harness.bootToken };
    const attach = await fetch(`${base}/attach`, {
      method: "POST",
      headers,
      credentials: "omit",
    });
    if (!attach.ok) throw new Error("The map chat could not be opened.");
    const { conversationId } = (await attach.json()) as {
      conversationId?: string;
    };
    if (!conversationId) throw new Error("The map chat could not be opened.");
    const history = await fetch(
      `${base}/session/${encodeURIComponent(conversationId)}/message`,
      { headers, credentials: "omit" },
    );
    if (!history.ok) throw new Error("The map chat could not be read.");
    return (await history.json()) as OpenCodeTurnMessage[];
  };

  /**
   * ↗ OPEN IN SESSION (4.3.7): a new terminal session at the project root
   * whose first message points at a file holding the transcript and the
   * selection, then its full view (on the Terminal, 4.4.2). The map chat is
   * left as it was.
   */
  const openInSession = async (): Promise<void> => {
    const selection = subjectRef.current;
    let messages: OpenCodeTurnMessage[];
    try {
      messages = await loadMapChat();
    } catch (error) {
      harness.showToast(errorMessage(error, "Couldn't read the map chat."));
      return;
    }
    try {
      await sessions.createSessionAt(projectRoot, "claude-code", {
        initialPrompt: openInSessionPrompt(selection),
        initialAttachments: [
          {
            kind: "inline",
            filename: "map-chat.md",
            dataUrl: markdownDataUrl(
              mapChatTranscript({
                projectLabel,
                projectRoot,
                selection,
                messages,
              }),
            ),
          },
        ],
      });
    } catch (error) {
      harness.showToast(errorMessage(error, "Couldn't start a session."));
    }
  };

  const revision = mapChat.revision(projectId);
  const handoffKey = useCallback(
    (callId: string) => `${projectId}:${revision}:${callId}`,
    [projectId, revision],
  );
  const handoffActions = useMemo<HandoffActions>(
    () => ({
      // Tool call ids are the conversation's own: keyed by project and New
      // chat revision, a fresh conversation's call never finds an old session.
      sessionFor: (callId) => mapChat.handoffSession(handoffKey(callId)),
      // I6: the session is made and NOT selected; the centre stays the map
      // and the map chat stays open. Its rail row pulses once.
      start: async (callId, args) => {
        try {
          const session = await sessions.createSessionAt(
            projectRoot,
            "claude-code",
            { initialPrompt: args.prompt, select: false },
          );
          mapChat.setHandoffSession(handoffKey(callId), session.id);
          return session.id;
        } catch (error) {
          harness.showToast(errorMessage(error, "Couldn't start the session."));
          return null;
        }
      },
      open: sessions.openSession,
    }),
    [handoffKey, harness, mapChat, projectRoot, sessions],
  );

  const takePending = useCallback(
    () => mapChat.takePending(projectId),
    [mapChat, projectId],
  );
  const surface: MapChatSurface = {
    placeholder:
      subject.kind === "project"
        ? "Ask about this project"
        : `Ask about ${subject.name}`,
    // A queued question already carries its context line (see onAsk).
    composePrompt: (question) =>
      parseAskPrompt(question).subject
        ? question
        : askPrompt(question, subjectRef.current),
    takePending,
  };

  const card = (
    <MapCard
      projectLabel={projectLabel}
      subject={subject}
      nodeKind={nodePick?.kind ?? null}
      agent={nodePick ? null : pickedAgent}
      canAsk={mapChat.canAsk}
      revealLabel={revealLabel()}
      // The question carries the pick it was asked about: a pick made while
      // the chat connects must not move it.
      onAsk={(question) => mapChat.ask(projectId, askPrompt(question, subject))}
      onOpenAgent={(agent) => onOpenAgent(projectId, agent.path)}
      onReveal={(agent) => {
        void revealAgentFolder(agent.path).then((revealed) => {
          if (!revealed)
            harness.showToast(`Couldn't open ${agent.name}'s folder.`);
        });
      }}
      chat={
        chatOpen
          ? {
              pane: (
                <HandoffContext.Provider value={handoffActions}>
                  <OpenCodeChat
                    key={`${harness.authRevision}:${projectId}:${mapChat.revision(projectId)}`}
                    harnessSessionId={mapChatHostKey(projectId)}
                    bootToken={harness.bootToken}
                    draft={mapChat.draft(projectId)}
                    onSignIn={onSignIn}
                    onOpenSettings={onOpenSettings}
                    onOpenTerminal={() => void openInSession()}
                    mapChat={surface}
                  />
                </HandoffContext.Provider>
              ),
              onNewChat: () => {
                void mapChat.reset(projectId).then((reset) => {
                  if (!reset)
                    harness.showToast(
                      "Couldn't start a new chat. Stop the current answer and try again.",
                    );
                });
              },
              onOpenInSession: () => void openInSession(),
              onClose: () => mapChat.setOpen(projectId, false),
            }
          : null
      }
    />
  );

  return (
    <ProjectViewFrame showing="map">
      {mapMode?.kind === "map" ? (
        /* Keyed by project, so switching projects is a fresh load rather
           than a mutation of the one on screen. */
        <AgentMapPane
          key={`${projectId}:${harness.authRevision}`}
          viewportStore={viewportStore}
          visible
          api={harness.api}
          workflows={state.workflows}
          refreshWorkflows={harness.refreshWorkflows}
          onPickAgent={(workflow) => {
            setNodePick(null);
            onPickAgent(workflow.path);
          }}
          onEnterAgent={(workflow) => onOpenAgent(projectId, workflow.path)}
          agentPicked={pickedAgent != null}
          nodePick={nodePick}
          onNodePick={(node) => {
            setNodePick(node);
            if (node) onClosePanel();
          }}
          onClearPick={clearPick}
          chatOpen={chatOpen}
          card={card}
          state={agentMapEntry.state.workspace}
          unavailable={agentMapEntry.state.unavailable}
          onRetry={agentMapEntry.retryWorkspace}
          initialization={agentMapEntry.initialization}
          onRetryGeneration={agentMapEntry.retryGeneration}
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
          selectedPath={pickedAgent?.path ?? null}
          onPick={(agent) => onPickAgent(agent.path)}
          onEnter={(agent) => onOpenAgent(projectId, agent.path)}
          panel={card}
        />
      )}
      {agentPath &&
        (modalAgent ? (
          <AgentModal
            harness={harness}
            state={state}
            agent={modalAgent}
            verbs={verbs}
            onOpenAgent={(path) => onOpenAgent(projectId, path)}
            onClose={() => onCloseAgent(projectId)}
          />
        ) : null)}
    </ProjectViewFrame>
  );
}
