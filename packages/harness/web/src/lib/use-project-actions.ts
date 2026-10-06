/**
 * The project doors: a project header click, opening a folder as a project,
 * the new-agent screen scoped to a project, template Use, Remove from the
 * rail, and the agent canvas entered from a project's map.
 */
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { HarnessEntry, HarnessKind } from "@shared/types";

import type { ProjectFolderIntent } from "../components/ProjectFolderDialog";
import type { RailProject } from "../components/WorkflowsRail";
import { errorMessage } from "./api";
import { getDesktopBridge } from "./desktop";
import { chooseProjectFolder } from "./folder-step";
import { FALLBACK_HARNESSES, isHarnessSelectable } from "./harness-registry";
import { basenameOf, samePath } from "./paths";
import type { ShellProjects } from "./shell-projects";
import type { GalleryTemplate, StudioTemplate } from "./templates";
import type { ComposerProject, Dialogs } from "./use-dialogs";
import type { HarnessStateHook } from "./use-harness-state";
import type { ShellNav } from "./use-session-actions";

export const useProjectActions = ({
  harness,
  projects,
  dialogs,
  nav,
  harnessChoice,
}: {
  harness: HarnessStateHook;
  projects: ShellProjects | null;
  dialogs: Dialogs;
  nav: ShellNav;
  /** The coding agent new sessions start with (`useSessionActions`). */
  harnessChoice: {
    harnessEntries: HarnessEntry[] | null;
    selectedHarness: HarnessKind;
    setSelectedHarness: Dispatch<SetStateAction<HarnessKind>>;
  };
}) => {
  const { harnessEntries, selectedHarness, setSelectedHarness } = harnessChoice;
  const state = harness.state;
  const { view, setView, navGenerationRef, setMapPanelPath, closeMobileDrawer } =
    nav;
  const {
    composing,
    composerProject,
    setComposing,
    setComposerProject,
    setReviewSummary,
    setTemplatesOpen,
    setOverviewOpen,
    setFolderPrompt,
    leaveDestinations,
  } = dialogs;
  const viewProjectId = view.kind === "session" ? null : view.projectId;
  /**
   * A project clicked before its durable identity reached the scope catalog.
   * The click refreshes the catalog, and its map opens when the id lands,
   * unless another navigation happened in between.
   */
  const [pendingProject, setPendingProject] = useState<{
    root: string;
    label: string;
    generation: number;
  } | null>(null);
  // The project-header door, reached from this effect; assigned below on every
  // render the shell itself renders, where `state` exists.
  const selectProjectRef = useRef<((project: RailProject) => void) | null>(
    null,
  );
  useEffect(() => {
    if (!pendingProject) return;
    if (pendingProject.generation !== navGenerationRef.current) {
      setPendingProject(null);
      return;
    }
    const projectId = harness.state?.workspaceScopes?.find((scope) =>
      samePath(scope.cwd, pendingProject.root),
    )?.projectId;
    if (!projectId) return;
    setPendingProject(null);
    // Through the same door a click takes, so an empty project still lands
    // on the new-agent screen (D36) rather than an empty map.
    selectProjectRef.current?.({
      root: pendingProject.root,
      label: pendingProject.label,
      projectId,
    });
  }, [pendingProject, harness.state?.workspaceScopes]);

  /**
   * LAND ON THE NEW-AGENT SCREEN, scoped to a project (flow-creation.md §4.3).
   *
   * One screen, every entrance: New project after its folder step, the map
   * header's New agent, an empty project's name (D36), and template Use. The
   * project is stated on the screen, never chosen there. Its Back returns to
   * the session it was opened over, never to a map the screen replaced.
   */
  const composeInProject = (project: ComposerProject): void => {
    navGenerationRef.current += 1;
    setView({ kind: "session" });
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    setComposerProject(project);
    setComposing(true);
    closeMobileDrawer();
  };

  /**
   * A PROJECT HEADER (flow-navigation.md 4.3): its Agent Map takes the centre
   * at full width, with no chat beside it. The selected session is NOT
   * touched (design.md I5): it stays highlighted in the rail and one click
   * brings it back, so a project click never ends, hides or swaps work.
   */
  const handleSelectProject = (project: RailProject): void => {
    if (!state || !projects) return;
    const generation = ++navGenerationRef.current;
    leaveDestinations();
    closeMobileDrawer();
    if (!project.projectId) {
      // The folder is in the rail but its durable identity has not reached
      // the scope catalog yet; its map opens once the refresh brings it.
      setPendingProject({
        root: project.root,
        label: project.label,
        generation,
      });
      void harness.refreshWorkspaceScopes().catch(() => {
        harness.showToast("Studio couldn't identify this project. Try again.");
      });
      return;
    }
    const projectId = project.projectId;
    if (viewProjectId !== projectId) setMapPanelPath(null);
    setView({ kind: "project", projectId });
    // AN EMPTY PROJECT'S NAME IS THE DOOR (D36, flow 4.6.2): a project with
    // no agent lands on the new-agent screen scoped to it rather than on a map
    // with nothing in it. The map is computed from the same folder, so the
    // folder's agents are the whole answer.
    if (projects.agentsInProject(projectId).length > 0) return;
    composeInProject({
      root: project.root,
      label: project.label,
      projectId,
      template: null,
    });
  };
  if (!harness.loading && !harness.error && state) {
    selectProjectRef.current = handleSelectProject;
  }

  /** Remove from the rail, confirmed: the project's sessions end and its row
   *  goes; nothing on disk is touched. A view of it gives way first. */
  const handleRemoveProject = async (root: string): Promise<void> => {
    const removedProjectId =
      projects?.workspaceScopes.find((scope) => samePath(scope.cwd, root))
        ?.projectId ?? null;
    if (removedProjectId && viewProjectId === removedProjectId) {
      navGenerationRef.current += 1;
      setView({ kind: "session" });
    }
    // The screen is mounted only with a project that exists.
    if (composerProject && samePath(composerProject.root, root)) {
      setComposerProject(null);
    }
    await harness.removeProject(root);
  };

  /** Back to the project's map from an agent's canvas entered on it. */
  const backToMap = (projectId: string): void => {
    navGenerationRef.current += 1;
    setView({ kind: "project", projectId });
  };

  /** Double click on the map, or Open canvas: the agent's canvas in the same
   *  centre, with the way back in the header (flow 4.4). */
  const openAgentCanvas = (projectId: string, path: string): void => {
    navGenerationRef.current += 1;
    leaveDestinations();
    closeMobileDrawer();
    setView({ kind: "agent", projectId, path });
  };

  /**
   * OPEN A FOLDER AS A PROJECT and land on its map (the rail's Add project,
   * the folder step's second half). The server mints the durable Studio
   * project and its agents scan in; the folder joins the rail, agents or not.
   * No session is created and no seeding turn runs (flow-creation.md §4.1
   * step 3, §4.5, Q5).
   *
   * Returns the project as the rail labels it, so New project can continue to
   * the new-agent screen scoped to exactly what was opened, or null when a
   * newer navigation won while the open was pending.
   */
  const openProjectIntoRail = async (
    requestedRoot: string,
  ): Promise<ComposerProject | null> => {
    const generation = ++navGenerationRef.current;
    const stale = (): boolean => generation !== navGenerationRef.current;
    const openedRoot = await harness.openProject(requestedRoot);
    if (stale()) return null;
    const opened: ComposerProject = {
      root: openedRoot,
      label: basenameOf(openedRoot) || openedRoot,
      projectId: null,
      template: null,
    };
    try {
      const refreshed = await harness.api.getState();
      if (stale()) return null;
      const scope = refreshed.workspaceScopes?.find((candidate) =>
        samePath(candidate.cwd, openedRoot),
      );
      const project = refreshed.studioProjects?.find(
        (candidate) => candidate.projectId === scope?.projectId,
      );
      if (!scope?.projectId || !project) return opened;
      opened.projectId = project.projectId;
      opened.label = project.displayName || opened.label;
      // The opened project's map is the answer to opening it, as a header
      // click would be. Still no session and no new-agent screen.
      setMapPanelPath(null);
      setView({ kind: "project", projectId: project.projectId });
    } catch {
      // Identity is best-effort here: the folder is in the rail either way.
    }
    return opened;
  };

  /**
   * THE FOLDER STEP'S ANSWER. The folder opens as a project either way; only
   * New project continues to the screen. Rejects with the sentence the web
   * dialog shows; the desktop path toasts it.
   */
  const handleProjectFolderChosen = async (
    root: string,
    intent: ProjectFolderIntent,
    template: StudioTemplate | null,
  ): Promise<void> => {
    const opened = await openProjectIntoRail(root);
    // A newer navigation won while the folder opened: it decided where the
    // user is, and a late folder choice does not replace that.
    if (!opened) return;
    if (intent === "new-project") {
      composeInProject({
        ...opened,
        template,
        ...(template ? { templateSurface: "template_gallery" as const } : {}),
      });
    }
  };

  /**
   * THE FOLDER STEP (flow-creation.md §4.1 step 2, D29). The desktop bridge's
   * picker directly, with no Studio dialog in front of it and no pre-chosen
   * parent (Q8); the one-field dialog only where there is no bridge. Cancel
   * returns the user to where they were: nothing opens, nothing is remembered.
   */
  const runFolderStep = (
    intent: ProjectFolderIntent,
    template: StudioTemplate | null = null,
  ): void => {
    // The control that asked is the one focus returns to when the web dialog
    // closes; captured here because more than one surface runs this step.
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void chooseProjectFolder({
      chooseDirectory: getDesktopBridge()?.chooseDirectory ?? null,
      startingAt: null,
      openDialog: () => setFolderPrompt({ intent, template, trigger }),
      onPicked: (root) => {
        void handleProjectFolderChosen(root, intent, template).catch(
          (err: unknown) => {
            harness.showToast(errorMessage(err, "Couldn't open that folder."));
          },
        );
      },
      onError: (message) => harness.showToast(message),
    });
  };
  const handleNewProject = (): void => runFolderStep("new-project");
  const handleAddProject = (): void => runFolderStep("add-project");

  /**
   * NEW AGENT IN A PROJECT YOU ALREADY HAVE (flow-creation.md §4.2, D33, D34).
   * The row that was pressed is the answer to "where"; the screen opens
   * scoped to it and asks only for the idea.
   */
  const handleCreateAgentInProject = (root: string, label: string): void => {
    const projectId =
      projects?.workspaceScopes.find((scope) => samePath(scope.cwd, root))
        ?.projectId ?? null;
    composeInProject({ root, label, projectId, template: null });
  };

  /**
   * "Use template" ROUTES THROUGH THE NEW-AGENT SCREEN (flow-creation.md §5,
   * CF-D11): the template is the idea, editable before send, and the agent is
   * created the way every agent is. In a project already on screen the
   * template lands there; with none, the folder step runs first and carries
   * the template to the screen. A starter is scaffolded as that starter at
   * submit; a gallery template is named in the session setup as the starting
   * point to bring in at build time (the clone is a network operation the
   * coding agent owns, with its own auth failure mode).
   */
  const handleUseTemplate = (template: StudioTemplate): void => {
    // A deep link can open before registry loading finishes. Resolve the
    // harness choice before the screen opens on an unavailable default.
    const selectable = (harnessEntries ?? FALLBACK_HARNESSES).filter(
      isHarnessSelectable,
    );
    if (!selectable.some((entry) => entry.id === selectedHarness)) {
      const fallback = selectable[0]?.id as HarnessKind | undefined;
      if (fallback) setSelectedHarness(fallback);
    }
    // The screen's project counts only while the screen is open: Back leaves
    // `composerProject` set for the disclosure and the clip, and a later Use
    // must land in the project selected since, not the one left behind.
    if (composing && composerProject) {
      composeInProject({
        ...composerProject,
        template,
        templateSurface: "template_gallery",
      });
      return;
    }
    const scope = viewProjectId ? projects?.projectScope(viewProjectId) : null;
    if (projects && scope?.projectId) {
      composeInProject({
        root: scope.cwd,
        label: projects.projectLabelOf(scope.projectId),
        projectId: scope.projectId,
        template,
        templateSurface: "template_gallery",
      });
      return;
    }
    runFolderStep("new-project", template);
  };

  /** The screen's own template row: the template becomes this screen's idea. */
  const handleComposerUseTemplate = (template: GalleryTemplate): void => {
    if (!composerProject) return;
    composeInProject({ ...composerProject, template, templateSurface: "welcome" });
  };

  return {
    handleSelectProject,
    handleRemoveProject,
    backToMap,
    openAgentCanvas,
    handleProjectFolderChosen,
    handleNewProject,
    handleAddProject,
    handleCreateAgentInProject,
    handleUseTemplate,
    handleComposerUseTemplate,
  };
};
export type ProjectActions = ReturnType<typeof useProjectActions>;
