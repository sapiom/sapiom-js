/**
 * "Open in Studio" deep links (sapiom://agent/<id>, sapiom://templates/<id>).
 * The cold-start target rides in on the ?agent=/?template= load-URL param;
 * warm links come via the desktop bridge. An agent the user has locally opens
 * on its project's map; a remote-only one is offered as a clone.
 */
import { useEffect, useRef } from "react";

import { deepLinkFromSearch } from "./deep-link";
import {
  getDesktopBridge,
  type DeepLinkAgentTarget,
  type DeepLinkTarget,
} from "./desktop";
import { joinPath } from "./paths";
import { projectIdForAgent, type ShellProjects } from "./shell-projects";
import { cloneDefinitionPrompt } from "./templates";
import type { Dialogs } from "./use-dialogs";
import type { HarnessStateHook } from "./use-harness-state";
import type { SessionActions, ShellNav } from "./use-session-actions";

export const useDeepLinks = ({
  harness,
  projects,
  dialogs,
  nav,
  sessions,
  openAgentCanvas,
}: {
  harness: HarnessStateHook;
  projects: ShellProjects | null;
  dialogs: Dialogs;
  nav: ShellNav;
  sessions: SessionActions;
  openAgentCanvas: (projectId: string, path: string) => void;
}) => {
  const state = harness.state;
  const {
    composing,
    composerProject,
    setCloneRequest,
    setDeepLinkTemplateId,
    setTemplatesOpen,
    setOverviewOpen,
  } = dialogs;
  const { createSessionAt, sendPromptWhenReady } = sessions;
  const viewProjectId = nav.view.kind === "session" ? null : nav.view.projectId;
  // The applier is a ref because it needs `state`, which exists only once the
  // boot fetch lands; the effects below reach it through the ref.
  const applyDeepLinkRef = useRef<((target: DeepLinkTarget) => void) | null>(
    null,
  );
  const focusExistingRef = useRef<((definitionId: string) => boolean) | null>(
    null,
  );
  const bindClonedRef = useRef<((definitionId: string) => boolean) | null>(
    null,
  );
  const coldDeepLinkRef = useRef<DeepLinkTarget | null>(deepLinkFromSearch());
  const coldDeepLinkHandledRef = useRef(false);
  // A clone kicked off from a remote-only deep link: focus the agent once the
  // workspace rescan surfaces it locally.
  const pendingCloneFocusRef = useRef<string | null>(null);

  // Warm deep link: the desktop bridge pushes a target while the app is running.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onDeepLink) return;
    return bridge.onDeepLink((target) => applyDeepLinkRef.current?.(target));
  }, []);

  // Cold-start deep link (?agent=): apply once, after the state has loaded, so a
  // locally-connected agent is matched instead of prompting to clone.
  useEffect(() => {
    if (harness.loading) return;
    const target = coldDeepLinkRef.current;
    if (!target || coldDeepLinkHandledRef.current) return;
    coldDeepLinkHandledRef.current = true;
    applyDeepLinkRef.current?.(target);
  }, [harness.loading]);

  // After a deep-link clone lands, the workspace rescan surfaces the agent with a
  // matching definitionId — bind the cloning session to it then, without
  // moving the centre off the chat that is doing the clone.
  useEffect(() => {
    const wantId = pendingCloneFocusRef.current;
    if (wantId && bindClonedRef.current?.(wantId)) {
      pendingCloneFocusRef.current = null;
    }
  }, [harness.state?.workflows]);

  // The appliers below close over `state`, so they are assigned on every
  // render the shell itself renders (never while it shows its loading or
  // connectivity screen); the effects above reach them through the refs.
  const booted = !harness.loading && !harness.error && state != null;
  // Open a deep-linked agent if the user has it locally: its modal, over its
  // project's map (flow-map-chat-overlay.md 4.2b); returns whether it was
  // found.
  if (booted) focusExistingRef.current = (definitionId: string): boolean => {
    const match = state?.workflows.find(
      (w) => w.definitionId != null && String(w.definitionId) === definitionId,
    );
    if (!match) return false;
    const projectId = projectIdForAgent(match.path, state);
    if (projectId) openAgentCanvas(projectId, match.path);
    return true;
  };
  // A cloned agent has landed: bind the session that cloned it.
  if (booted) bindClonedRef.current = (definitionId: string): boolean => {
    const match = state?.workflows.find(
      (w) => w.definitionId != null && String(w.definitionId) === definitionId,
    );
    if (!match) return false;
    const activeSession =
      state?.sessions.find((session) => session.id === harness.activeSessionId) ??
      null;
    if (activeSession && activeSession.status !== "exited") {
      void harness.bindWorkflow(activeSession.id, match.path).catch(() => {});
    }
    return true;
  };

  // Resolve a deep-link target. A template (`sapiom://templates/<id>`) opens the
  // templates browser on that template; an agent (`sapiom://agent/<id>`) opens
  // it if present, else offers to clone it locally — the remote-only fallback.
  if (booted) applyDeepLinkRef.current = (target: DeepLinkTarget): void => {
    if (target.kind === "template") {
      nav.navGenerationRef.current += 1;
      setDeepLinkTemplateId(target.templateId);
      setTemplatesOpen(true);
      setOverviewOpen(false);
      return;
    }
    if (focusExistingRef.current?.(target.definitionId)) return;
    setCloneRequest(target);
  };

  // Clone a remote-only deep-linked agent locally (confirmed): open a session in a
  // fresh folder and hand the coding agent the clone-by-definitionId prompt — the
  // same agent-driven path "Use template" uses. The workspace rescan then surfaces
  // the cloned agent, and the pending-focus effect above displays it.
  const handleCloneDefinition = async (
    target: DeepLinkAgentTarget,
  ): Promise<void> => {
    setCloneRequest(null);
    // NO DEFAULT PARENT (Q8). A clone lands inside a project the user has:
    // the one on screen, else the most recently opened one. With none open,
    // the honest answer is to open one first.
    const parentRoot =
      (composing ? composerProject?.root : undefined) ??
      (viewProjectId ? projects?.projectScope(viewProjectId)?.cwd : undefined) ??
      harness.settings?.recentDirs[0] ??
      null;
    if (!parentRoot) {
      harness.showToast("Open a project first: New project picks the folder.");
      return;
    }
    // A repeated clone of the same definition gets its own folder: the clone
    // refuses a non-empty target, so the base name takes a numeric suffix
    // when the parent already holds it.
    const baseName = target.slug?.trim() || `agent-${target.definitionId}`;
    const taken = new Set(
      await harness
        .listDir(parentRoot)
        .then((listing) => listing.dirs.map((dir) => dir.name))
        .catch(() => [] as string[]),
    );
    let cloneName = baseName;
    for (let n = 2; taken.has(cloneName); n += 1) cloneName = `${baseName}-${n}`;
    const cwd = joinPath(parentRoot, cloneName);
    pendingCloneFocusRef.current = target.definitionId;
    try {
      const session = await createSessionAt(cwd, "claude-code", {
        initialUserInputPending: true,
      });
      sendPromptWhenReady(
        session.id,
        cloneDefinitionPrompt(target.definitionId, cwd),
        "Couldn't send the clone prompt. Ask the coding agent to run sapiom_dev_agents_clone.",
      );
    } catch (err) {
      pendingCloneFocusRef.current = null;
      harness.showToast(
        (err as Error).message ||
          "Couldn't start a session to clone the agent.",
      );
    }
  };

  return { handleCloneDefinition };
};
