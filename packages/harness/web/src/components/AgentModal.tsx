import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { AppState, WorkflowInfo } from "@shared/types";

import { createApi } from "../lib/api";
import { DIALOG_LAYER_SELECTOR } from "../lib/dialog-focus";
import { canvasSourceFor, lifecycleVerbGate } from "../lib/session-scope";
import type { AgentVerbs } from "../lib/use-agent-verbs";
import { useDialogBehavior } from "../lib/use-dialog-behavior";
import { useDismissable } from "../lib/use-dismissable";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import type { HarnessStateHook, ObservedRun } from "../lib/use-harness-state";
import { CanvasPane } from "./CanvasPane";
import { Icon, type IconName } from "./Icon";
import { SecretsPanel } from "./SecretsPanel";
import { StepCard } from "./StepCard";
import "../styles/agent-modal.css";

/**
 * The workflow-keyed board read (IA-01). Module-level, like the entered page
 * it replaces had it, so mock mode keeps ONE fixture instance.
 */
const boardApi = createApi();

export type AgentModalTab = "canvas" | "secrets";

const TABS: Record<AgentModalTab, { label: string; icon: IconName }> = {
  canvas: { label: "Canvas", icon: "GitBranch" },
  secrets: { label: "Secrets", icon: "Shield" },
};

/** A verb in the modal's header row (flow 4.4b). */
type AgentVerb = "visualize" | "run_local" | "prod_run" | "deploy";

const VERBS: { id: AgentVerb; label: string; icon: IconName }[] = [
  { id: "visualize", label: "Visualize", icon: "RefreshCw" },
  { id: "run_local", label: "Run locally", icon: "FlaskConical" },
  { id: "prod_run", label: "Run", icon: "Play" },
  { id: "deploy", label: "Deploy", icon: "CloudUpload" },
];

type Progress = { text: string; tone: "busy" | "done" | "failed" };

/** Another dialog or popover is open above this modal (a secret's dialog, the
 *  Run sheet, a menu): Escape and outside presses belong to it, not here. */
function anotherLayerAbove(
  scrim: Element | null,
  surface: Element | null,
): boolean {
  if (!scrim) return false;
  return Array.from(document.querySelectorAll(DIALOG_LAYER_SELECTOR)).some(
    (layer) => layer !== scrim && layer !== surface && !layer.contains(scrim),
  );
}

/**
 * THE AGENT MODAL (flow-map-chat-overlay.md 4.2b; mock `AgentModal.tsx`): one
 * agent's Canvas and Secrets over the project's map. Opened by the card's Open
 * agent, a double click on the map, or the finder; closed by ×, Escape or the
 * scrim, which return to exactly the map that was left. The map, its pick and
 * its map chat stay mounted underneath and are never touched (I9).
 *
 * - It leaves the rail and a margin of the map visible (4.2b.3).
 * - Two tabs, Canvas and Secrets (4.2b.2). A step picked on the board shows a
 *   small card inside the modal (4.2b.4); no step page, no Steps tab.
 * - The header row carries the agent's verbs as visible controls, never a
 *   menu: Visualize (the board's re-read by path), Run locally, Run, Deploy.
 *   Deploy and Visualize need no session; Run opens the Run sheet, whose
 *   launch is `useAgentVerbs`' (by agent path once P4.2b lands).
 */
export function AgentModal({
  harness,
  state,
  agent,
  verbs,
  onOpenAgent,
  onClose,
}: {
  harness: HarnessStateHook;
  state: AppState;
  agent: WorkflowInfo;
  verbs: AgentVerbs;
  /** A launched child agent, opened in this modal in its place. */
  onOpenAgent: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<AgentModalTab>("canvas");
  const [boardRevision, setBoardRevision] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const deployed = agent.definitionId != null;

  // A child agent opened in place starts on its own Canvas, fresh.
  useEffect(() => {
    setTab("canvas");
    setProgress(null);
  }, [agent.path]);

  // The scrim starts past the rail: the rail stays visible and is not under
  // the modal (4.2b.3). Read from the layout, so a resized or collapsed rail
  // moves it too.
  const [railEdge, setRailEdge] = useState(0);
  useLayoutEffect(() => {
    const measure = (): void => {
      const main = document.querySelector(".workspace-main");
      setRailEdge(main ? Math.round(main.getBoundingClientRect().left) : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Focus containment, focus restore and the inert background are the shared
  // dialog's. Dismissal is the shared light-dismiss too (I7), guarded so that
  // a layer opened above this one (a secret's dialog, the Run sheet) takes its
  // own Escape instead of closing the modal under it.
  useDialogBehavior({
    containerRef,
    headerRef,
    onDismiss: onClose,
    dismissable: false,
    initialFocusRef: closeRef,
  });
  // What the last press landed on, read before the light-dismiss sees it: a
  // press outside the modal counts only when it is ON the scrim. A menu the
  // board opens (the run picker) portals to the body, outside the modal, and
  // choosing from it must not close the modal under it.
  const pressRef = useRef<EventTarget | null>(null);
  useEffect(() => {
    const onPress = (event: MouseEvent): void => {
      pressRef.current = event.target;
    };
    const onKey = (): void => {
      pressRef.current = null;
    };
    document.addEventListener("mousedown", onPress, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPress, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);
  const dismiss = useCallback((): void => {
    if (anotherLayerAbove(backdropRef.current, containerRef.current)) return;
    const press = pressRef.current;
    if (press && press !== backdropRef.current) return;
    onClose();
  }, [onClose]);
  useDismissable(true, { onDismiss: dismiss, containerRef });

  // Deploy progress is the store's, by path.
  const deploy = harness.deployStateByPath.get(agent.path) ?? null;
  useEffect(() => {
    if (!deploy) return;
    setProgress(
      deploy.phase === "ready"
        ? { text: "Deployed", tone: "done" }
        : deploy.phase === "error"
          ? { text: deploy.message ?? "Deploy failed", tone: "failed" }
          : { text: "Deploying…", tone: "busy" },
    );
  }, [deploy]);

  // The modal's runs are the agent's, from the store keyed by agent path:
  // the shown one (latest, or the one picked) and every one observed.
  const runs = useMemo(
    () =>
      (harness.runIdsByAgent.get(agent.path) ?? [])
        .map((id) => harness.runsByExecution.get(id))
        .filter((observed): observed is ObservedRun => observed != null),
    [harness.runIdsByAgent, harness.runsByExecution, agent.path],
  );
  const run: ObservedRun | null = harness.runsByAgent.get(agent.path) ?? null;

  // A re-read that brings back no graph (an agent with nothing to render)
  // posts no graph message: the progress line clears rather than spinning.
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (renderTimer.current) clearTimeout(renderTimer.current);
    },
    [],
  );
  const visualize = (): void => {
    setProgress({ text: "Rendering…", tone: "busy" });
    setBoardRevision((revision) => revision + 1);
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = setTimeout(
      () =>
        setProgress((current) =>
          current?.text === "Rendering…" ? null : current,
        ),
      10_000,
    );
  };

  // The same gate the run bar used, from the same inputs: the agent's own
  // deployment and the account's connection (`lifecycleVerbGate`).
  const verbDisabledReason = (verb: AgentVerb): string | null => {
    if (verb === "visualize") return null;
    if (
      verb === "deploy" &&
      deploy &&
      deploy.phase !== "ready" &&
      deploy.phase !== "error"
    )
      return "Deploying…";
    return lifecycleVerbGate(
      verb === "deploy" ? "deploy" : verb === "prod_run" ? "run" : "test",
      {
        subject: agent,
        authenticated: state.authenticated === true,
        deployError: harness.lastDeployErrorFor(agent.path),
      },
    ).reason;
  };

  const runVerb = (verb: AgentVerb, control: HTMLElement): void => {
    switch (verb) {
      case "visualize":
        visualize();
        return;
      case "deploy":
        setProgress({ text: "Deploying…", tone: "busy" });
        void harness.deploy(agent.path);
        return;
      case "run_local":
      case "prod_run":
        verbs.setRunRequest({
          workflow: agent,
          target: verb === "run_local" ? "local" : "prod",
          returnFocus: control,
        });
        return;
    }
  };

  const style = { "--agent-modal-left": `${railEdge}px` } as CSSProperties;

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop agent-modal-backdrop"
      style={style}
    >
      <div
        ref={containerRef}
        className="agent-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-modal-name"
        tabIndex={-1}
        data-testid="agent-modal"
        data-agent={agent.name}
        data-tab={tab}
        {...trackingAttrs({ dialog: "agent_modal", object: "agent" })}
      >
        <div ref={headerRef} className="agent-modal-head">
          <Icon name="Zap" size={14} />
          <span
            id="agent-modal-name"
            className="agent-modal-name"
            data-testid="agent-modal-name"
            data-tooltip={agent.path}
          >
            {agent.name}
          </span>
          <span className="agent-modal-state" data-testid="agent-modal-state">
            {deployed ? "Deployed" : "Draft"}
          </span>
          <div className="agent-modal-tabs" role="tablist" aria-label={agent.name}>
            {(Object.keys(TABS) as AgentModalTab[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={"agent-modal-tab" + (tab === key ? " is-active" : "")}
                data-testid={`agent-modal-tab-${key}`}
                onClick={() => setTab(key)}
              >
                <Icon name={TABS[key].icon} size={14} />
                <span>{TABS[key].label}</span>
              </button>
            ))}
          </div>
          {progress && (
            <span
              className="agent-modal-progress"
              data-testid="agent-modal-progress"
              data-tone={progress.tone}
              role="status"
            >
              {progress.tone === "busy" && (
                <span className="agent-modal-progress-dot" aria-hidden="true" />
              )}
              {progress.text}
            </span>
          )}
          <div className="agent-modal-verbs">
            {VERBS.map((verb) => {
              const reason = verbDisabledReason(verb.id);
              return (
                <button
                  key={verb.id}
                  type="button"
                  className={
                    "theme-toggle agent-modal-verb" +
                    (verb.id === "deploy" ? " is-primary" : "")
                  }
                  data-testid={`agent-modal-${verb.id.replace("_", "-")}`}
                  aria-label={reason ? `${verb.label}: ${reason}` : verb.label}
                  data-tooltip={reason ?? verb.label}
                  disabled={reason != null}
                  onClick={(event) => runVerb(verb.id, event.currentTarget)}
                >
                  <Icon name={verb.icon} size={16} />
                </button>
              );
            })}
            <button
              ref={closeRef}
              type="button"
              className="theme-toggle agent-modal-close"
              data-testid="agent-modal-close"
              aria-label="Close"
              data-tooltip="Close"
              onClick={onClose}
            >
              <Icon name="X" size={16} />
            </button>
          </div>
        </div>

        {/* Kept mounted behind Secrets, so the board survives a tab flip. */}
        <div
          className={"agent-modal-panel" + (tab === "canvas" ? "" : " is-hidden")}
          data-testid="agent-modal-panel-canvas"
          role="tabpanel"
        >
          <CanvasPane
            key={`agent:${agent.path}:${boardRevision}`}
            sessionId={null}
            lastMessage={harness.lastMessage}
            subjectWorkflow={agent}
            source={canvasSourceFor({
              subjectPath: agent.path,
              bindingPath: null,
              sessionId: null,
            })}
            loadWorkflowGraph={boardApi.getWorkflowGraph.bind(boardApi)}
            overviewActive={false}
            sessionExited={false}
            expanded={false}
            onToggleExpanded={() => {}}
            macros={state.macros}
            tasks={harness.tasks}
            surface="board"
            onOpenSteps={() => {}}
            run={run?.run ?? null}
            runTarget={run?.target ?? null}
            runs={runs}
            onSelectRun={(executionId) => harness.selectRun(agent.path, executionId)}
            preview={null}
            deployState={deploy}
            onDismissDeploy={() => harness.dismissDeployState(agent.path)}
            agentsBaseUrl={state.agentsBaseUrl}
            onOpenCode={() => {}}
            workflows={state.workflows}
            onOpenWorkflow={onOpenAgent}
            onRunMacro={(fired) => {
              // The board's Visualize CTA and render-error Retry re-read the
              // board by path; no session renders it (4.4b).
              if (fired.id === "visualize") visualize();
              else verbs.handleRunMacroForWorkflow(agent, fired);
            }}
            /* Ask, fix and debug from the board: a new project-root session
               whose first message names the job and this agent (4.4b). */
            onInjectPrompt={(text) => verbs.handleAskAgent(agent, text)}
            onDescribeWorkflow={verbs.handleDescribeWithAI}
            onGraphChange={(path) => {
              if (path === agent.path)
                setProgress((current) =>
                  current?.text === "Rendering…"
                    ? { text: "Rendered", tone: "done" }
                    : current,
                );
            }}
            stepCard={(node, graph, clear) => (
              <StepCard
                node={node}
                graph={graph}
                workflows={state.workflows}
                onOpenAgent={onOpenAgent}
                onClose={clear}
              />
            )}
          />
        </div>
        {tab === "secrets" && (
          <div
            className="agent-modal-panel"
            data-testid="agent-modal-panel-secrets"
            role="tabpanel"
          >
            <SecretsPanel
              api={harness.api}
              workflow={agent}
              onToast={(message) => harness.showToast(message)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
