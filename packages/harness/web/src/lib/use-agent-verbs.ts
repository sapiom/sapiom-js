/**
 * What can be done TO an agent: visualize and the other macros, deploy, run
 * (locally or in the cloud), Describe with AI, and Change location. Today each
 * verb binds the agent to a live session first (`handleBindWorkflow`); P4.2b
 * addresses them by agent path instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MacroDef,
  WorkflowInfo,
  WorkflowInputContractResponse,
} from "@shared/types";

import { errorMessage } from "./api";
import { describeWorkflowPrompt } from "./describe-prompt";
import { refuseMove } from "./agent-move";
import { resolveMacroUrl } from "./macro-gating";
import { directActionKind } from "./macro-actions";
import { basenameOf, isWithinDir, parentOf, samePath } from "./paths";
import { railSessions } from "./rail-sessions";
import { rootContains } from "./session-scope";
import { projectIdForAgent, type ShellProjects } from "./shell-projects";
import type { HarnessStateHook, RunTarget } from "./use-harness-state";
import type { SessionActions, ShellNav } from "./use-session-actions";
import {
  isWorkflowRunnable,
  prodRunBlockedToast,
  workflowDeploymentState,
} from "./workflow-deployment";

export const useAgentVerbs = ({
  harness,
  projects,
  nav,
  sessions,
  now,
}: {
  harness: HarnessStateHook;
  projects: ShellProjects | null;
  nav: ShellNav;
  sessions: SessionActions;
  now: number;
}) => {
  const state = harness.state;
  const { setView, setMapPanelPath, closeMobileDrawer } = nav;
  const { hiddenSessionIds, createSessionAt, openSession } = sessions;
  const [runRequest, setRunRequest] = useState<{
    workflow: WorkflowInfo;
    target: RunTarget;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const visibleInputContractsRef = useRef(
    new Map<string, WorkflowInputContractResponse>(),
  );
  const loadRunInputContract = useCallback(
    async (workflowPath: string): Promise<WorkflowInputContractResponse> => {
      const fallback = visibleInputContractsRef.current.get(workflowPath);
      try {
        const fresh = await harness.getWorkflowInputContract(workflowPath);
        return fresh.status === "unavailable" && fallback ? fallback : fresh;
      } catch (error) {
        if (fallback) return fallback;
        throw error;
      }
    },
    [harness.getWorkflowInputContract],
  );

  // Describe-with-AI outcome feedback. The run is a hidden background task that
  // never takes over the board — but it must never finish SILENTLY either.
  // Toast when a describe task leaves "running" (the exact "spins then stops
  // with no result and no message" report). On success the canvas also
  // re-renders on its own from the edited source.
  const describeTaskStatus = useRef(new Map<string, string>());
  useEffect(() => {
    for (const task of harness.tasks) {
      if (task.macroId !== "describe") continue;
      const prev = describeTaskStatus.current.get(task.id);
      if (prev === "running" && task.status !== "running") {
        harness.showToast(
          task.status === "failed"
            ? "Couldn't generate descriptions — check the agent terminal for details."
            : "Describe run finished — the canvas updates if the agent changed the source.",
          task.status === "failed" ? "error" : "success",
        );
      }
      describeTaskStatus.current.set(task.id, task.status);
    }
  }, [harness.tasks, harness.showToast]);

  /**
   * CHANGE LOCATION on the agent's panel (flow 4.4.3), after the confirm that
   * names both paths. It replaced the rail's drag-to-move, which moved an
   * agent on a gesture that could land by accident. The panel stays open on
   * the agent at its new path; sessions bound to it follow it (the server
   * remaps them, and `moveAgent` re-reads them, design.md I7).
   */
  const handleMoveAgent = async (from: string, to: string): Promise<void> => {
    try {
      await harness.moveAgent(from, to);
      setMapPanelPath((current) =>
        current && samePath(current, from) ? to : current,
      );
      setView((current) =>
        current.kind === "agent" && samePath(current.path, from)
          ? { ...current, path: to }
          : current,
      );
      harness.showToast(`Moved ${basenameOf(to)} to ${to}.`, "info");
    } catch (err) {
      harness.showToast(errorMessage(err, `Couldn't move ${basenameOf(from)}.`));
    }
  };
  /**
   * Why `to` cannot be the agent's new location, under the field. The rules
   * are the move route's own (`src/server/agent-move.ts`): a move keeps the
   * agent's folder name and lands in a folder of an open project. The server
   * guards again with what only it can see (the disk, and exactly which
   * folders it accepts), and its refusal arrives as a toast.
   */
  const locationRefusal = (from: string, to: string): string | null => {
    if (!state || !projects) return null;
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(to)) return "Use an absolute path.";
    const name = basenameOf(from);
    if (samePath(to, from)) return null;
    if (isWithinDir(from, to)) return `Can't move ${name} inside itself.`;
    if (basenameOf(to) !== name)
      return `Keep the folder name ${name}: Change location moves the agent, it does not rename it.`;
    const parent = parentOf(to);
    if (
      parent == null ||
      !projects.workspaceScopes.some((scope) => rootContains(scope.cwd, parent))
    )
      return "Pick a folder inside one of your open projects.";
    return refuseMove(
      state.workflows.map((workflow) => workflow.path),
      from,
      to,
    );
  };

  /**
   * Binds an agent to a live session in its own project and shows that
   * session — used when navigating to a launched sub-agent from the board, and
   * before running a macro against an agent (the canvas is served from the
   * binding). It lands on the selected session when that session is in the
   * agent's project, else the project's newest live session, else STARTS one
   * at the project ROOT (SAP-2927: passing the agent's own directory brought a
   * session up without the project's CLAUDE.md, .claude/ or skills). Resolves
   * to the session the binding landed on.
   */
  const handleBindWorkflow = async (path: string): Promise<string | null> => {
    if (!state || !projects) return null;
    closeMobileDrawer();
    const projectId = projectIdForAgent(path, state);
    const live = railSessions(
      state.sessions,
      projectId,
      hiddenSessionIds,
      now,
    ).filter((session) => session.status !== "exited");
    const owner =
      live.find((session) => session.id === harness.activeSessionId) ??
      live[0];
    let targetId: string;
    if (owner) {
      targetId = owner.id;
    } else {
      try {
        targetId = (
          await createSessionAt(projects.sessionCwdForAgent(path), "claude-code")
        ).id;
      } catch (err) {
        harness.showToast(
          errorMessage(err, "Couldn't start a session in this folder."),
        );
        return null;
      }
    }
    await harness.bindWorkflow(targetId, path);
    openSession(targetId);
    return targetId;
  };

  // Shared by the canvas Visualize CTA, the steps macros, and anything else
  // that fires a macro. Running a macro against a workflow (re-)binds too — the
  // canvas is served from the binding, so a render on an unbound workflow would
  // draw into the wrong root.
  const handleRunMacroForWorkflow = (
    workflow: WorkflowInfo | null,
    macro: MacroDef,
  ): void => {
    void (async () => {
      // Deploy / Prod-run / Run-local run via the DIRECT harness routes (no
      // Claude Code, no user LLM credits). Once a macro is a direct action we
      // NEVER fall through to the pty-inject runMacro — the buttons are already
      // gated (require a workflow / a deploy), so a missing prerequisite here is
      // a no-op, never a silent revert to the Claude Code path.
      const direct = directActionKind(macro.id);
      let sessionId = harness.activeSessionId;
      if (workflow)
        sessionId = (await handleBindWorkflow(workflow.path)) ?? sessionId;
      if (macro.action.kind === "open-url") {
        window.open(
          resolveMacroUrl(macro.action.url, workflow),
          "_blank",
          "noopener,noreferrer",
        );
        return;
      }
      if (!sessionId) return;
      if (direct !== null) {
        if (direct === "deploy") {
          if (!workflow) {
            harness.showToast("Select an agent first.");
          } else {
            void harness.deploy(workflow.path);
          }
        } else if (direct === "prod-run") {
          if (workflow?.definitionId != null && isWorkflowRunnable(workflow)) {
            // The definition has a ready cloud build; the runs route wants its
            // id as a string.
            void harness.startProdRun(sessionId, String(workflow.definitionId));
          } else {
            // The button is already disabled in SessionStepsBar when there is
            // no ready build. This branch protects keyboard/programmatic calls.
            const lastErr = workflow
              ? harness.lastDeployErrorFor(workflow.path)
              : null;
            const deploymentState = workflow
              ? workflowDeploymentState(workflow, lastErr)
              : "draft";
            harness.showToast(prodRunBlockedToast(deploymentState));
          }
        } else if (direct === "run-local") {
          if (!workflow) {
            harness.showToast("Select an agent first.");
          } else {
            void harness.runLocal(sessionId, workflow.path);
          }
        }
        return;
      }
      // Visualize (render-canvas) and every inject macro (Debug / Explain /
      // free-form) keep their existing path through runMacro.
      void harness.runMacro(macro.id, {
        harnessSessionId: sessionId,
        workflowPath: workflow?.path,
      });
    })();
  };

  const handleLaunchRun = (input: unknown): void => {
    const request = runRequest;
    if (!request) return;
    // The launch surface closes immediately while binding / network work
    // continues.
    setRunRequest(null);
    void (async () => {
      const sessionId =
        (await handleBindWorkflow(request.workflow.path)) ??
        harness.activeSessionId;
      if (!sessionId) return;
      if (request.target === "prod") {
        if (
          request.workflow.definitionId == null ||
          !isWorkflowRunnable(request.workflow)
        ) {
          harness.showToast("This agent needs a ready cloud deployment first.");
          return;
        }
        await harness.startProdRun(
          sessionId,
          String(request.workflow.definitionId),
          input,
        );
      } else {
        await harness.runLocal(sessionId, request.workflow.path, input);
      }
    })();
  };

  // "Describe with AI": run the describe macro HEADLESS (execution:"background")
  // so the agent edits the workflow source out of sight — never the interactive
  // terminal. The prompt is passed as the macro's `subject`; the source watcher
  // re-renders the canvas when the agent saves. The button's loading state is
  // driven by the resulting background task (see CanvasPane `describeRunning`).
  const handleDescribeWithAI = (workflow: WorkflowInfo): void => {
    void (async () => {
      const sessionId =
        (await handleBindWorkflow(workflow.path)) ?? harness.activeSessionId;
      if (!sessionId) return;
      void harness.runMacro("describe", {
        harnessSessionId: sessionId,
        workflowPath: workflow.path,
        subject: describeWorkflowPrompt(workflow),
      });
    })();
  };

  return {
    runRequest,
    setRunRequest,
    loadRunInputContract,
    handleMoveAgent,
    locationRefusal,
    handleBindWorkflow,
    handleRunMacroForWorkflow,
    handleLaunchRun,
    handleDescribeWithAI,
  };
};

export type AgentVerbs = ReturnType<typeof useAgentVerbs>;
