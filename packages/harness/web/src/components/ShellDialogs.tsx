import type { JSX } from "react";
import type { AppState, HarnessSession } from "@shared/types";

import { CloneAgentConfirm } from "./CloneAgentConfirm";
import { CommandPalette } from "./CommandPalette";
import { HelpOverlay } from "./HelpOverlay";
import { OverviewModal } from "./OverviewModal";
import {
  ProjectFolderDialog,
  type ProjectFolderIntent,
} from "./ProjectFolderDialog";
import { RemoveProjectConfirm } from "./RemoveProjectConfirm";
import { RunSheet } from "./RunSheet";
import { getDesktopBridge, type DeepLinkAgentTarget } from "../lib/desktop";
import type { PaletteAction } from "../lib/palette";
import { planProjectRemoval } from "../lib/project-membership";
import type { StudioTemplate } from "../lib/templates";
import { toggleTheme } from "../lib/theme";
import type { AgentVerbs } from "../lib/use-agent-verbs";
import type { Dialogs } from "../lib/use-dialogs";
import type { HarnessStateHook } from "../lib/use-harness-state";
import type { SessionActions, ShellNav } from "../lib/use-session-actions";

/**
 * The cards ON TOP of the shell: the Overview, the folder step's web dialog,
 * the one-time explainer, the command palette, the clone and remove confirms,
 * and the run sheet. They mount beside the centre rather than standing in for
 * it, and each outlives whichever control opened it.
 */
export function ShellDialogs({
  harness,
  state,
  dialogs,
  nav,
  sessions,
  verbs,
  activeSession,
  sessionRoot,
  railCollapsed,
  onToggleRail,
  onAddProject,
  onFolderChosen,
  onCloneDefinition,
  onRemoveProject,
}: {
  harness: HarnessStateHook;
  state: AppState;
  dialogs: Dialogs;
  nav: ShellNav;
  sessions: SessionActions;
  verbs: AgentVerbs;
  activeSession: HarnessSession | null;
  sessionRoot: (session: HarnessSession) => string;
  railCollapsed: boolean;
  onToggleRail: () => void;
  onAddProject: () => void;
  onFolderChosen: (
    root: string,
    intent: ProjectFolderIntent,
    template: StudioTemplate | null,
  ) => Promise<void>;
  onCloneDefinition: (target: DeepLinkAgentTarget) => Promise<void>;
  onRemoveProject: (root: string) => Promise<void>;
}): JSX.Element {
  const {
    overviewOpen,
    setOverviewOpen,
    setTemplatesOpen,
    folderPrompt,
    setFolderPrompt,
    paletteOpen,
    setPaletteOpen,
    setDeepLinkTemplateId,
    cloneRequest,
    setCloneRequest,
    removing,
    setRemoving,
    removeTriggerRef,
  } = dialogs;
  const { navGenerationRef } = nav;
  const { runRequest, setRunRequest } = verbs;
  return (
    <>
      {/* The Overview is a card ON TOP of the shell, so it mounts beside the
          palette rather than standing in for the workbench. */}
      {overviewOpen && (
        <OverviewModal
          firstRun={state.firstRun === true}
          appVersion={getDesktopBridge()?.appVersion || __STUDIO_VERSION__}
          onAddProject={onAddProject}
          onBrowseTemplates={() => {
            navGenerationRef.current += 1;
            setOverviewOpen(false);
            setTemplatesOpen(true);
          }}
          onDismiss={() => setOverviewOpen(false)}
        />
      )}

      {/* The web half of the folder step (D29). Mounted beside the other
          cards-on-top: it outlives the rail control that asked for it, and it
          is the same dialog whichever surface ran the step. */}
      {folderPrompt && (
        <ProjectFolderDialog
          intent={folderPrompt.intent}
          initialPath=""
          listDir={harness.listDir}
          triggerRef={{ current: folderPrompt.trigger }}
          onClose={() => setFolderPrompt(null)}
          onChoose={(root) =>
            onFolderChosen(root, folderPrompt.intent, folderPrompt.template)
          }
        />
      )}

      {/* The one-time explainer. It owns WHEN it shows (first run, the account
          menu's "How Studio is organised"); the shell owns WHERE the "already
          seen" fact lives, because that fact has to outlive a browser origin —
          the desktop app boots on a new ephemeral port every launch, so a flag
          in `localStorage` reopened the card every time (SAP-2991). */}
      <HelpOverlay
        // Absent settings reads as "not seen", which shows the card. That is
        // the safe failure the card has always chosen over a broken shell.
        seen={harness.settings?.helpSeen === true}
        onSeen={() => {
          // Best-effort, exactly as the old storage write was: a rejected
          // PATCH costs one extra showing on the next launch, never a
          // dismissal that refuses to dismiss.
          void harness.updateSettings({ helpSeen: true }).catch(() => {});
        }}
      />

      {paletteOpen && (
        <CommandPalette
          sessions={state.sessions}
          workflows={state.workflows}
          recentDirs={harness.settings?.recentDirs ?? []}
          history={harness.history}
          sessionNames={sessions.sessionNames}
          activeSessionId={harness.activeSessionId}
          listDir={harness.listDir}
          listTemplates={harness.listTemplates}
          onSelectSession={sessions.openSession}
          onReviewSummary={sessions.reviewPastSession}
          onOpenPath={(cwd) =>
            void sessions.handleCreateSession(cwd, "claude-code")
          }
          onOpenTemplate={(templateId) => {
            navGenerationRef.current += 1;
            setDeepLinkTemplateId(templateId);
            setTemplatesOpen(true);
            setOverviewOpen(false);
          }}
          actions={
            [
              {
                id: "browse-templates",
                label: "Browse templates",
                meta: "Gallery and starters",
                icon: "LayoutTemplate",
                run: () => {
                  navGenerationRef.current += 1;
                  setTemplatesOpen(true);
                  setOverviewOpen(false);
                },
              },
              {
                id: "toggle-theme",
                label: "Toggle theme",
                meta: "Light and dark",
                icon: "Sun",
                run: toggleTheme,
              },
              {
                id: "toggle-rail",
                label: railCollapsed
                  ? "Show workspace panel"
                  : "Hide workspace panel",
                meta: "Left pane",
                icon: "Menu",
                run: onToggleRail,
              },
              ...(activeSession
                ? [
                    {
                      id: "new-session-here",
                      label: "New session in this folder",
                      // The project root, not the active session's raw cwd
                      // (SAP-2927) — and `meta` shows the resolved folder, so a
                      // session an older build left in an agent's directory
                      // cannot make this row name a folder it will not open.
                      meta: sessionRoot(activeSession),
                      icon: "Plus",
                      run: () =>
                        void sessions.handleCreateSession(
                          sessionRoot(activeSession),
                          "claude-code",
                        ),
                    },
                  ]
                : []),
            ] satisfies PaletteAction[]
          }
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {cloneRequest && (
        <CloneAgentConfirm
          agentLabel={
            cloneRequest.slug
              ? `“${cloneRequest.slug}”`
              : `Agent ${cloneRequest.definitionId}`
          }
          onCancel={() => setCloneRequest(null)}
          onConfirm={() => void onCloneDefinition(cloneRequest)}
        />
      )}

      {runRequest && (
        <RunSheet
          workflow={runRequest.workflow}
          target={runRequest.target}
          loadContract={verbs.loadRunInputContract}
          returnFocus={runRequest.returnFocus}
          onClose={() => setRunRequest(null)}
          onRun={verbs.handleLaunchRun}
        />
      )}

      {removing && (
        <RemoveProjectConfirm
          label={removing.label}
          root={removing.root}
          /* Counted from the SAME plan that does the ending, so the number the
             dialog names and the sessions that die cannot drift apart. */
          runningCount={
            planProjectRemoval({
              root: removing.root,
              recentDirs: harness.settings?.recentDirs ?? [],
              sessions: state.sessions,
            }).endSessionIds.length
          }
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void onRemoveProject(target.root);
          }}
          triggerRef={removeTriggerRef}
        />
      )}
    </>
  );
}
