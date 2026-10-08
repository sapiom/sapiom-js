import type { CanvasMapRequest } from "../lib/project-map";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { AppState, WorkflowInfo } from "@shared/types";

import { getByAgentPath } from "../lib/agent-path-lookup";
import { createApi } from "../lib/api";
import { DIALOG_LAYER_SELECTOR } from "../lib/dialog-focus";
import { relativeTimeLabel } from "../lib/relative-time";
import { inputContractFromCanvasGraph } from "../lib/run-input";
import { canvasSourceFor, lifecycleVerbGate } from "../lib/session-scope";
import type { AgentVerbs } from "../lib/use-agent-verbs";
import { useDialogBehavior } from "../lib/use-dialog-behavior";
import { useDismissable } from "../lib/use-dismissable";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import type { HarnessStateHook, ObservedRun } from "../lib/use-harness-state";
import {
  isWorkflowRunnable,
  snippetsPendingSentence,
  workflowDeploymentState,
} from "../lib/workflow-deployment";
import { AnchoredPopover } from "./AnchoredPopover";
import { CanvasPane } from "./CanvasPane";
import { Icon, type IconName } from "./Icon";
import { RunsPanel } from "./RunsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { SnippetPanel } from "./SnippetPanel";
import { StepCard } from "./StepCard";
import "../styles/agent-modal.css";

/**
 * The workflow-keyed board read (IA-01). Module-level, like the entered page
 * it replaces had it, so mock mode keeps ONE fixture instance.
 */
const boardApi = createApi();

export type AgentModalTab = "canvas" | "runs" | "secrets";

const TABS: Record<AgentModalTab, { label: string; icon: IconName }> = {
  canvas: { label: "Canvas", icon: "GitBranch" },
  runs: { label: "Runs", icon: "Play" },
  secrets: { label: "Secrets", icon: "Shield" },
};

/**
 * When a deploy from this tab reached `ready`, by agent path. WorkflowInfo
 * carries no deployed-at, so the header can only say when for a deploy it
 * watched; every other deployed agent reads "Deployed" (nothing absent is
 * drawn). Module-level, so it outlives the modal closing.
 */
const deployedAtByPath = new Map<string, number>();

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
 *  Run sheet, the board's run picker): Escape and outside presses belong to
 *  it, not here. A menu is not a dialog layer, so it is named separately; a
 *  listbox INSIDE the modal (the Runs tab's attempt timeline) is part of the
 *  modal, not a layer above it. */
function anotherLayerAbove(
  scrim: Element | null,
  surface: Element | null,
): boolean {
  if (!scrim) return false;
  const menus = document.querySelectorAll('[role="menu"], [role="listbox"]');
  if (Array.from(menus).some((menu) => !surface?.contains(menu))) return true;
  return Array.from(document.querySelectorAll(DIALOG_LAYER_SELECTOR)).some(
    (layer) => layer !== scrim && layer !== surface && !layer.contains(scrim),
  );
}

/**
 * THE AGENT MODAL (flow-map-chat-overlay.md 4.2b, 4.7; mock `AgentModal.tsx`):
 * one agent's Canvas, Runs and Secrets over the project's map. Opened by the card's Open
 * agent, a double click on the map, or the finder; closed by ×, Escape or the
 * scrim, which return to exactly the map that was left. The map, its pick and
 * its map chat stay mounted underneath and are never touched (I9).
 *
 * - It leaves the rail and a margin of the map visible (4.2b.3).
 * - Three tabs, Canvas, Runs and Secrets (4.2b.2, 4.7.1). A step picked on
 *   the board shows a small card inside the modal (4.2b.4); no step page, no
 *   Steps tab. Runs is the run workspace the old right pane had.
 * - The header row (4.7.2) states Deployed (with when, if known) or Draft,
 *   and carries `</>` (the integration snippets) and the agent's verbs as
 *   visible controls, never a menu: Visualize (the board's re-read by path),
 *   Run locally, Run, Deploy. None needs a session; Run opens the Run sheet,
 *   whose launch is `useAgentVerbs`' by agent path.
 * - No breadcrumbs (4.7.6): nothing in the modal navigates to a project
 *   view. A launched child agent replaces the modal's subject, no crumb.
 */
export function AgentModal({
  harness,
  state,
  agent,
  verbs,
  onOpenAgent,
  onClose,
  canvasMap = null,
}: {
  harness: HarnessStateHook;
  state: AppState;
  agent: WorkflowInfo;
  verbs: AgentVerbs;
  /** A launched child agent, opened in this modal in its place. */
  onOpenAgent: (path: string) => void;
  onClose: () => void;
  /** This agent's steps and edges from the project map at the ref it is drawn
   *  at (design.md M6); null draws the working copy alone. */
  canvasMap?: CanvasMapRequest | null;
}): JSX.Element {
  const [tab, setTab] = useState<AgentModalTab>("canvas");
  const canvasMapKey = canvasMap ? JSON.stringify(canvasMap) : "";
  const canvasMapRef = useRef(canvasMap);
  canvasMapRef.current = canvasMap;
  const [boardRevision, setBoardRevision] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const snippetsRef = useRef<HTMLButtonElement>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const deployed = agent.definitionId != null;

  // A child agent opened in place starts on its own Canvas, fresh.
  useEffect(() => {
    setTab("canvas");
    setProgress(null);
    setSnippetsOpen(false);
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
  // Whether a layer sat above this one when the last key went down, read in
  // the capture phase, before any layer's own Escape handler runs. The layer
  // above closes on that same Escape, and its state flush can land between
  // the two bubble listeners: read after it, the modal would see no layer
  // and close under it on the press that was the layer's.
  const layerAtKeyRef = useRef(false);
  useEffect(() => {
    const onPress = (event: MouseEvent): void => {
      pressRef.current = event.target;
    };
    const onKey = (): void => {
      pressRef.current = null;
      layerAtKeyRef.current = anotherLayerAbove(
        backdropRef.current,
        containerRef.current,
      );
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
    if (!press && layerAtKeyRef.current) return;
    if (press && press !== backdropRef.current) return;
    // Escape unwinds one layer: a picked step's card first (CanvasPane
    // releases the pick on the same key), then the modal. Only a card on
    // screen counts: on the Secrets tab the board, and its card, are hidden.
    const card = containerRef.current?.querySelector<HTMLElement>(".step-card");
    if (!press && card && card.offsetParent !== null) return;
    onClose();
  }, [onClose]);
  useDismissable(true, { onDismiss: dismiss, containerRef });

  // Deploy progress is the store's, by path.
  const deploy = harness.deployStateByPath.get(agent.path) ?? null;
  useEffect(() => {
    if (!deploy) return;
    if (deploy.phase === "ready" && !deployedAtByPath.has(agent.path))
      deployedAtByPath.set(agent.path, Date.now());
    setProgress(
      deploy.phase === "ready"
        ? { text: "Deployed", tone: "done" }
        : deploy.phase === "error"
          ? { text: deploy.message ?? "Deploy failed", tone: "failed" }
          : { text: "Deploying…", tone: "busy" },
    );
  }, [deploy, agent.path]);
  // A new deploy starts a new "when".
  useEffect(() => {
    if (deploy && deploy.phase !== "ready") deployedAtByPath.delete(agent.path);
  }, [deploy, agent.path]);
  const deployedAt = deployed ? deployedAtByPath.get(agent.path) : undefined;

  // What `</>` shows: the snippets for a ready cloud build, else why not yet.
  const snippetsPending = !deployed
    ? `Deploy ${agent.name} first. Its snippets appear once it has a ready cloud build.`
    : isWorkflowRunnable(agent)
      ? null
      : snippetsPendingSentence(workflowDeploymentState(agent, null), agent.name);

  // The modal's runs are the agent's, from the store keyed by agent path:
  // the shown one (latest, or the one picked) and every one observed.
  const runs = useMemo(
    () =>
      (getByAgentPath(harness.runIdsByAgent, agent.path) ?? [])
        .map((id) => harness.runsByExecution.get(id))
        .filter((observed): observed is ObservedRun => observed != null),
    [harness.runIdsByAgent, harness.runsByExecution, agent.path],
  );
  const run: ObservedRun | null =
    getByAgentPath(harness.runsByAgent, agent.path) ?? null;

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
            {deployed
              ? deployedAt != null
                ? `Deployed ${relativeTimeLabel(deployedAt)}`
                : "Deployed"
              : "Draft"}
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
            <button
              ref={snippetsRef}
              type="button"
              className={
                "theme-toggle agent-modal-verb" + (snippetsOpen ? " is-active" : "")
              }
              data-testid="agent-modal-snippets"
              aria-label="Integration snippets"
              aria-haspopup="dialog"
              aria-expanded={snippetsOpen}
              data-tooltip="Snippets"
              onClick={() => setSnippetsOpen((open) => !open)}
            >
              <Icon name="Code" size={16} />
            </button>
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
            // A map read that changes this agent's steps or edges redraws the board.
            key={`agent:${agent.path}:${boardRevision}:${canvasMapKey}`}
            sessionId={null}
            lastMessage={harness.lastMessage}
            subjectWorkflow={agent}
            source={canvasSourceFor({
              subjectPath: agent.path,
              bindingPath: null,
              sessionId: null,
            })}
            loadWorkflowGraph={(path) => boardApi.getWorkflowGraph(path, canvasMapRef.current)}
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
            onGraphChange={(path, graph) => {
              // The board's entry contract backs the Run sheet when a fresh
              // extraction reports unavailable.
              const contract = inputContractFromCanvasGraph(graph);
              if (contract) verbs.rememberVisibleContract(path, contract);
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
        {tab === "runs" && (
          <div
            className="agent-modal-panel"
            data-testid="agent-modal-panel-runs"
            role="tabpanel"
          >
            <RunsPanel
              agent={agent}
              runs={runs}
              shown={run}
              onSelectRun={(executionId) => harness.selectRun(agent.path, executionId)}
              onAskAgent={(text) => verbs.handleAskAgent(agent, text)}
            />
          </div>
        )}
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
      {/* Portalled to the body; a dialog layer, so the modal's Escape and
          scrim leave it alone while it is open. */}
      <AnchoredPopover
        open={snippetsOpen}
        anchorRef={snippetsRef}
        onDismiss={() => setSnippetsOpen(false)}
        placement="down-end"
        className="agent-modal-snippets-popover"
        role="dialog"
        testid="agent-modal-snippets-popover"
      >
        {snippetsPending ? (
          <p
            className="agent-modal-snippets-pending"
            data-testid="agent-modal-snippets-pending"
          >
            {snippetsPending}
          </p>
        ) : (
          <SnippetPanel
            key={agent.path}
            boundWorkflow={agent}
            agentsBaseUrl={state.agentsBaseUrl}
          />
        )}
      </AnchoredPopover>
    </div>
  );
}
