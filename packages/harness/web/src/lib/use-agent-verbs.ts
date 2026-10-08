/**
 * What can be done TO an agent: visualize and the other macros, deploy, run
 * (locally or in the cloud), Ask / Describe with AI, and Change location.
 * Every verb is addressed by the agent's path; none takes, binds or needs a
 * session (design-map-chat.md I2, I3; flow-map-chat-overlay.md 4.4b).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MacroDef,
  WorkflowInfo,
  WorkflowInputContractResponse,
} from "@shared/types";

import { errorMessage } from "./api";
import { refuseMove } from "./agent-move";
import {
  agentMacroFirstMessage,
  type AgentMacroKind,
} from "./agent-session-macro";
import { agentVerbRoute } from "./agent-verb-route";
import { basenameOf, isWithinDir, parentOf, samePath } from "./paths";
import { rootContains } from "./session-scope";
import type { ShellProjects } from "./shell-projects";
import type { HarnessStateHook, RunTarget } from "./use-harness-state";
import type { SessionActions, ShellNav } from "./use-session-actions";
import { isWorkflowRunnable } from "./workflow-deployment";

export const useAgentVerbs = ({
  harness,
  projects,
  nav,
  sessions,
}: {
  harness: HarnessStateHook;
  projects: ShellProjects | null;
  nav: ShellNav;
  sessions: SessionActions;
  /** Unused since the verbs stopped picking a live session to bind; kept so
   *  the shell's call compiles until it drops the argument. */
  now?: number;
}) => {
  const state = harness.state;
  const { setView, setMapPanelPath, closeMobileDrawer } = nav;
  const { createSessionAt } = sessions;
  const [runRequest, setRunRequest] = useState<{
    workflow: WorkflowInfo;
    target: RunTarget;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const visibleInputContractsRef = useRef(
    new Map<string, WorkflowInputContractResponse>(),
  );
  /** The entry contract a surface's board shows for an agent: the Run
   *  sheet's fallback when a fresh extraction reports unavailable. */
  const rememberVisibleContract = useCallback(
    (workflowPath: string, contract: WorkflowInputContractResponse): void => {
      visibleInputContractsRef.current.set(workflowPath, contract);
    },
    [],
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
   * The verb macros (Ask, Ask to modify, Ask to fix, the run-attempt debug,
   * Describe with AI): a NEW session at the agent's project root, unbound,
   * whose first message names the job and the agent (agent-session-macro.ts),
   * opened in the full view. Never a binding (design-map-chat.md I2): the
   * session is ordinary project-root work, and the agent is context in the
   * message.
   */
  const startAgentMacro = (
    workflow: WorkflowInfo,
    job: AgentMacroKind,
    text = "",
  ): void => {
    if (!projects) return;
    closeMobileDrawer();
    void createSessionAt(projects.sessionCwdForAgent(workflow.path), "claude-code", {
      initialPrompt: agentMacroFirstMessage(job, workflow, text),
    }).catch((err: unknown) => {
      harness.showToast(
        errorMessage(err, `Couldn't start a session for ${workflow.name}.`),
      );
    });
  };

  /** What a surface's "Ask coding agent" composed, about `workflow`. */
  const handleAskAgent = (
    workflow: WorkflowInfo,
    text: string,
    job: Exclude<AgentMacroKind, "describe"> = "ask",
  ): void => startAgentMacro(workflow, job, text);

  // Shared by the canvas Visualize CTA and render-error Retry, a failed task's
  // Retry, the run buttons and anything else that fires a macro. Every route
  // is by agent path (agent-verb-route.ts); none needs, binds or starts a
  // session except the macro session itself.
  const handleRunMacroForWorkflow = (
    workflow: WorkflowInfo | null,
    macro: MacroDef,
  ): void => {
    const route = agentVerbRoute(
      macro,
      workflow,
      workflow ? harness.lastDeployErrorFor(workflow.path) : null,
    );
    switch (route.kind) {
      case "open-url":
        window.open(route.url, "_blank", "noopener,noreferrer");
        return;
      case "refuse":
        harness.showToast(route.reason);
        return;
      case "deploy":
        void harness.deploy(route.agentPath);
        return;
      case "prod-run":
        void harness.startProdRun(route.agentPath, route.definitionId);
        return;
      case "run-local":
        void harness.runLocal(route.agentPath);
        return;
      case "reload-graph":
        harness.reloadAgentGraph(route.agentPath);
        return;
      case "session-macro":
        if (workflow) startAgentMacro(workflow, route.job, route.text);
        return;
    }
  };

  const handleLaunchRun = (input: unknown): void => {
    const request = runRequest;
    if (!request) return;
    setRunRequest(null);
    const { workflow } = request;
    if (request.target === "prod") {
      if (workflow.definitionId == null || !isWorkflowRunnable(workflow)) {
        harness.showToast("This agent needs a ready cloud deployment first.");
        return;
      }
      void harness.startProdRun(workflow.path, String(workflow.definitionId), input);
    } else {
      void harness.runLocal(workflow.path, input);
    }
  };

  // "Describe with AI": the same macro rule as Ask (flow 4.4b), with the
  // describe prompt as the job. The source watcher re-renders the canvas when
  // the session saves the descriptions.
  const handleDescribeWithAI = (workflow: WorkflowInfo): void =>
    startAgentMacro(workflow, "describe");

  return {
    runRequest,
    setRunRequest,
    loadRunInputContract,
    rememberVisibleContract,
    handleMoveAgent,
    locationRefusal,
    handleAskAgent,
    handleRunMacroForWorkflow,
    handleLaunchRun,
    handleDescribeWithAI,
  };
};

export type AgentVerbs = ReturnType<typeof useAgentVerbs>;
