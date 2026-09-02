import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  CSSProperties,
  FormEvent,
  JSX,
  KeyboardEvent,
  RefObject,
} from "react";

import {
  BUILD_PLAN_REQUEST,
  EDITOR_FOLLOW_UP,
  GOLDEN_PATH_REQUEST,
  LAUNCH_BUILDERS_REQUEST,
  agentMapDemoBuilderSession,
  agentMapDemoHasProposal,
  agentMapDemoNodeStatus,
  agentMapDemoNodes,
  agentMapDemoReducer,
  agentMapDemoRelationships,
  createInitialAgentMapDemoState,
  type AgentMapDemoBuilderSession,
  type AgentMapDemoBuilderSessionId,
  type AgentMapDemoBuilderStep,
  type AgentMapDemoNode,
  type AgentMapDemoNodeId,
  type AgentMapDemoNodeKind,
  type AgentMapDemoRelationship,
  type AgentMapDemoState,
  type AgentMapDemoTurn,
} from "../lib/agent-map-demo";
import { BrandHeader } from "./BrandHeader";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

interface ComposerSuggestion {
  label: string;
  text: string;
}

const MAP_NODE_SUMMARIES: Record<AgentMapDemoNodeId, string> = {
  "market-research": "Ranks today’s market leaders",
  "marketing-publisher": "Owns the video and publish",
  "research-database": "Persists ResearchReport",
  tiktok: "Publishes the news video",
  "news-editor": "Selects the strongest points",
};

const NODE_ICONS: Record<AgentMapDemoNodeKind, string> = {
  Agent: "Brain",
  Resource: "BookOpen",
  Connector: "Plug",
  "Owned subagent": "Sparkles",
};

function suggestionFor(state: AgentMapDemoState): ComposerSuggestion | null {
  switch (state.phase) {
    case "opening":
      return { label: "Use demo brief", text: GOLDEN_PATH_REQUEST };
    case "proposal":
      return { label: "Add editorial review", text: EDITOR_FOLLOW_UP };
    case "subagent-proposal":
      return { label: "Reply “yes”", text: "yes" };
    case "confirmed":
      return { label: "Show build plan", text: BUILD_PLAN_REQUEST };
    case "build-plan":
      return {
        label: "Approve simulated launch",
        text: LAUNCH_BUILDERS_REQUEST,
      };
    case "builders-launched":
      return null;
  }
}

function mapStatus(state: AgentMapDemoState): {
  label: string;
  tone: "neutral" | "confirmed" | "staged";
} {
  switch (state.phase) {
    case "opening":
      return { label: "Empty draft", tone: "neutral" };
    case "proposal":
    case "subagent-proposal":
      return { label: `Proposal · rev ${state.revision}`, tone: "neutral" };
    case "confirmed":
    case "build-plan":
      return { label: `Confirmed · rev ${state.revision}`, tone: "confirmed" };
    case "builders-launched":
      return { label: "Builders simulated", tone: "staged" };
  }
}

export function AgentMapDemo(): JSX.Element {
  const [state, dispatch] = useReducer(
    agentMapDemoReducer,
    undefined,
    createInitialAgentMapDemoState,
  );
  const [draft, setDraft] = useState("");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = state.selectedBuilderId
      ? 0
      : transcript.scrollHeight;
  }, [state.selectedBuilderId, state.turns.length]);

  const nodes = useMemo(() => agentMapDemoNodes(state), [state]);
  const relationships = useMemo(
    () => agentMapDemoRelationships(state),
    [state],
  );
  const selectedNode =
    nodes.find((node) => node.id === state.selectedNodeId) ?? null;
  const selectedBuilder = state.selectedBuilderId
    ? agentMapDemoBuilderSession(state.selectedBuilderId)
    : null;
  const suggestion = suggestionFor(state);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    dispatch({ type: "submit", text });
    setDraft("");
  };

  const reset = (): void => {
    dispatch({ type: "reset" });
    setDraft("");
    setRailCollapsed(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  return (
    <div
      className={
        "agent-map-demo-shell" + (railCollapsed ? " is-rail-collapsed" : "")
      }
      data-testid="agent-map-demo"
    >
      {!railCollapsed && (
        <AgentMapRail
          state={state}
          onCollapse={() => setRailCollapsed(true)}
          onToggleProject={() => dispatch({ type: "toggle-project" })}
          onSelectNode={(nodeId) => dispatch({ type: "select-node", nodeId })}
          onSelectBuilder={(builderId) =>
            dispatch({ type: "select-builder", builderId })
          }
          onReset={reset}
        />
      )}

      <main className="agent-map-demo-workspace">
        {selectedBuilder ? (
          <BuilderSessionPane
            session={selectedBuilder}
            railCollapsed={railCollapsed}
            onExpandRail={() => setRailCollapsed(false)}
            transcriptRef={transcriptRef}
          />
        ) : (
          <section
            className="agent-map-demo-conversation center-pane"
            aria-label="Planning conversation"
          >
            <header className="agent-map-demo-pane-header agent-map-demo-conversation-header">
              {railCollapsed && (
                <button
                  type="button"
                  className="theme-toggle"
                  aria-label="Expand workspace panel"
                  data-testid="agent-map-demo-rail-expand"
                  onClick={() => setRailCollapsed(false)}
                >
                  <Icon name="PanelLeftOpen" size={14} />
                </button>
              )}
              <span className="agent-map-demo-header-icon">
                <Icon name="MessageSquare" size={15} />
              </span>
              <div className="agent-map-demo-header-copy">
                <span className="agent-map-demo-header-title">
                  Plan with Planner
                </span>
                <span className="agent-map-demo-header-meta">
                  Stock video desk
                </span>
              </div>
              <span className="status-tag agent-map-demo-local-status">
                <Icon name="FlaskConical" size={12} />
                Concept demo
              </span>
            </header>

            <div
              className="agent-map-demo-transcript"
              data-testid="agent-map-demo-transcript"
              ref={transcriptRef}
            >
              <div className="agent-map-demo-transcript-inner">
                {state.turns.map((turn) => (
                  <DemoTurn key={turn.id} turn={turn} state={state} />
                ))}
              </div>
            </div>

            <form
              className="agent-map-demo-composer-wrap"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                submit();
              }}
            >
              {suggestion && (
                <div className="agent-map-demo-suggestion-row">
                  <span>Prepared walkthrough</span>
                  <button
                    type="button"
                    className="composer-chip agent-map-demo-suggestion"
                    data-testid="agent-map-demo-suggestion"
                    onClick={() => {
                      setDraft(suggestion.text);
                      composerRef.current?.focus();
                    }}
                  >
                    <Icon name="Sparkles" size={13} />
                    {suggestion.label}
                  </button>
                </div>
              )}
              <div className="composer-box agent-map-demo-composer">
                <textarea
                  ref={composerRef}
                  className="composer-input"
                  data-testid="agent-map-demo-input"
                  aria-label="Message the demo planner"
                  placeholder="Continue the planning conversation…"
                  rows={2}
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-box-actions">
                  <span className="agent-map-demo-composer-note">
                    Scripted locally · no calls are made
                  </span>
                  <div className="composer-box-right">
                    <button
                      type="submit"
                      className="composer-send"
                      data-testid="agent-map-demo-send"
                      disabled={!draft.trim()}
                      aria-label="Send message"
                    >
                      <Icon name="ArrowUp" size={15} />
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </section>
        )}

        <section
          className="agent-map-demo-map right-pane"
          aria-label={
            selectedBuilder ? "Builder step structure" : "Project Agent Map"
          }
        >
          {selectedBuilder ? (
            <BuilderStepsPane session={selectedBuilder} />
          ) : (
            <AgentMapPane
              state={state}
              nodes={nodes}
              relationships={relationships}
              selectedNode={selectedNode}
              onSelectNode={(nodeId) =>
                dispatch({ type: "select-node", nodeId })
              }
            />
          )}
        </section>
      </main>
    </div>
  );
}

function AgentMapRail({
  state,
  onCollapse,
  onToggleProject,
  onSelectNode,
  onSelectBuilder,
  onReset,
}: {
  state: AgentMapDemoState;
  onCollapse: () => void;
  onToggleProject: () => void;
  onSelectNode: (nodeId: AgentMapDemoNodeId | null) => void;
  onSelectBuilder: (builderId: AgentMapDemoBuilderSessionId) => void;
  onReset: () => void;
}): JSX.Element {
  const hasProposal = agentMapDemoHasProposal(state);
  const buildersLaunched = state.phase === "builders-launched";

  return (
    <aside className="rail rail-workflows agent-map-demo-rail">
      <BrandHeader
        onCollapse={onCollapse}
        canGoBack={false}
        canGoForward={false}
        onGoBack={() => undefined}
        onGoForward={() => undefined}
      />
      <div className="rail-header">
        <span className="rail-header-label">Projects</span>
      </div>
      <div className="rail-tree">
        <div className="rail-list agent-map-demo-rail-list">
          <div className="workspace-group agent-map-demo-project">
            <div
              className={
                "workspace-row" + (state.projectExpanded ? "" : " is-collapsed")
              }
            >
              <button
                type="button"
                className="workspace-row-main"
                data-testid="agent-map-demo-project-toggle"
                aria-expanded={state.projectExpanded}
                aria-controls="agent-map-demo-project-children"
                onClick={onToggleProject}
              >
                <Icon name="Folder" size={13} />
                <span className="tree-row-label">Stock video desk</span>
                <span
                  className={
                    "workspace-caret" +
                    (state.projectExpanded ? " is-open" : "")
                  }
                >
                  <Icon name="ChevronDown" size={12} />
                </span>
              </button>
            </div>

            {state.projectExpanded && (
              <div
                id="agent-map-demo-project-children"
                className="agent-map-demo-project-children"
              >
                <button
                  type="button"
                  className={
                    "agent-map-demo-rail-row" +
                    (state.selectedBuilderId ? "" : " is-selected")
                  }
                  data-testid="agent-map-demo-rail-map"
                  aria-current={state.selectedBuilderId ? undefined : "page"}
                  onClick={() => onSelectNode(null)}
                >
                  <Icon name="Waypoints" size={13} />
                  <span>Agent Map</span>
                  <span className="agent-map-demo-pin" aria-label="Pinned">
                    pinned
                  </span>
                </button>

                {hasProposal && (
                  <div
                    className="agent-map-demo-agent-rows"
                    data-testid="agent-map-demo-agent-rows"
                  >
                    <AgentRailRow
                      label="Market Research"
                      nodeId="market-research"
                      builderLabel={
                        buildersLaunched ? "Research builder" : null
                      }
                      builderId={
                        buildersLaunched ? "market-research-builder" : null
                      }
                      selectedBuilderId={state.selectedBuilderId}
                      onSelectNode={(nodeId) => onSelectNode(nodeId)}
                      onSelectBuilder={onSelectBuilder}
                    />
                    <AgentRailRow
                      label="Marketing / Publisher"
                      nodeId="marketing-publisher"
                      builderLabel={
                        buildersLaunched ? "Publisher builder" : null
                      }
                      builderId={
                        buildersLaunched ? "marketing-publisher-builder" : null
                      }
                      selectedBuilderId={state.selectedBuilderId}
                      onSelectNode={(nodeId) => onSelectNode(nodeId)}
                      onSelectBuilder={onSelectBuilder}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <footer className="rail-footer agent-map-demo-rail-footer">
        <span className="status-tag">
          <Icon name="FlaskConical" size={12} />
          Local concept fixture
        </span>
        <button
          type="button"
          className="btn-ghost agent-map-demo-reset"
          data-testid="agent-map-demo-reset"
          onClick={onReset}
        >
          <Icon name="RefreshCw" size={13} />
          Reset demo
        </button>
      </footer>
    </aside>
  );
}

function AgentRailRow({
  label,
  nodeId,
  builderLabel,
  builderId,
  selectedBuilderId,
  onSelectNode,
  onSelectBuilder,
}: {
  label: string;
  nodeId: AgentMapDemoNodeId;
  builderLabel: string | null;
  builderId: AgentMapDemoBuilderSessionId | null;
  selectedBuilderId: AgentMapDemoBuilderSessionId | null;
  onSelectNode: (nodeId: AgentMapDemoNodeId) => void;
  onSelectBuilder: (builderId: AgentMapDemoBuilderSessionId) => void;
}): JSX.Element {
  return (
    <div className="agent-map-demo-agent-rail-group">
      <button
        type="button"
        className="agent-map-demo-rail-row agent-map-demo-agent-row"
        data-testid={`agent-map-demo-rail-agent-${nodeId}`}
        onClick={() => onSelectNode(nodeId)}
      >
        <Icon name="Brain" size={13} />
        <span>{label}</span>
        <span className="status-tag-dot" aria-hidden="true" />
      </button>
      {builderLabel && builderId && (
        <button
          type="button"
          className={
            "agent-map-demo-builder-row" +
            (selectedBuilderId === builderId ? " is-selected" : "")
          }
          data-testid={`agent-map-demo-builder-${nodeId}`}
          aria-current={selectedBuilderId === builderId ? "page" : undefined}
          onClick={() => onSelectBuilder(builderId)}
        >
          <Icon name="Hammer" size={12} />
          <span>{builderLabel}</span>
          <span className="agent-map-demo-builder-meta">simulated</span>
        </button>
      )}
    </div>
  );
}

function BuilderSessionPane({
  session,
  railCollapsed,
  onExpandRail,
  transcriptRef,
}: {
  session: AgentMapDemoBuilderSession;
  railCollapsed: boolean;
  onExpandRail: () => void;
  transcriptRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  return (
    <section
      className="agent-map-demo-conversation agent-map-demo-builder-session center-pane"
      aria-label={`${session.agentLabel} simulated builder session`}
      data-testid="agent-map-demo-builder-session"
      data-builder-session={session.id}
    >
      <header className="agent-map-demo-pane-header agent-map-demo-conversation-header">
        {railCollapsed && (
          <button
            type="button"
            className="theme-toggle"
            aria-label="Expand workspace panel"
            data-testid="agent-map-demo-rail-expand"
            onClick={onExpandRail}
          >
            <Icon name="PanelLeftOpen" size={14} />
          </button>
        )}
        <span className="agent-map-demo-header-icon">
          <Icon name="SquareTerminal" size={15} />
        </span>
        <div className="agent-map-demo-header-copy">
          <span className="agent-map-demo-header-title">
            {session.agentLabel} builder
          </span>
          <span className="agent-map-demo-header-meta">
            Simulated child implementation session
          </span>
        </div>
        <span className="status-tag agent-map-demo-local-status">
          <Icon name="FlaskConical" size={12} />
          Snapshot · no session
        </span>
      </header>

      <div
        className="agent-map-demo-transcript agent-map-demo-builder-transcript"
        data-testid="agent-map-demo-builder-transcript"
        ref={transcriptRef}
      >
        <div className="agent-map-demo-transcript-inner agent-map-demo-builder-transcript-inner">
          <details
            className="agent-map-demo-builder-context"
            data-testid="agent-map-demo-builder-context"
            open
          >
            <summary>
              <span className="agent-map-demo-planner-mark">
                <Icon name="GitBranch" size={12} />
              </span>
              <span className="agent-map-demo-builder-context-title">
                <strong>Mock startup context</strong>
                <span>Planner injection preview · expanded by default</span>
              </span>
              <span className="status-tag">mock only</span>
              <Icon name="ChevronDown" size={13} />
            </summary>
            <div className="agent-map-demo-builder-context-layers">
              {session.contextLayers.map((layer) => (
                <section
                  key={layer.id}
                  className={`agent-map-demo-builder-context-layer is-${layer.id}`}
                  data-testid={`agent-map-demo-builder-context-layer-${layer.id}`}
                >
                  <h3>{layer.label}</h3>
                  <ul>
                    {layer.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </details>

          <article
            className="agent-map-demo-turn is-planner agent-map-demo-builder-reply"
            data-testid="agent-map-demo-builder-first-reply"
          >
            <div className="agent-map-demo-turn-role">
              <span className="agent-map-demo-planner-mark">
                <Icon name="Hammer" size={12} />
              </span>
              <span>{session.railLabel}</span>
              <span className="agent-map-demo-turn-meta">
                scripted snapshot
              </span>
            </div>
            <div className="agent-map-demo-turn-body">
              <Markdown text={session.firstReply} />
              <ol className="agent-map-demo-builder-reply-steps">
                {session.steps.map((step) => (
                  <li key={step.id}>{step.label}</li>
                ))}
              </ol>
              <p className="agent-map-demo-builder-reply-gate">
                Please confirm or refine this decomposition before
                implementation.
              </p>
            </div>
          </article>
        </div>
      </div>

      <div
        className="agent-map-demo-composer-wrap agent-map-demo-builder-composer-wrap"
        data-testid="agent-map-demo-builder-composer"
      >
        <div className="agent-map-demo-suggestion-row">
          <span>Simulated session snapshot</span>
          <span className="status-tag">non-interactive</span>
        </div>
        <div className="composer-box agent-map-demo-composer agent-map-demo-builder-composer">
          <textarea
            className="composer-input"
            aria-label="Simulated builder composer"
            placeholder="This concept snapshot cannot send messages."
            rows={2}
            value=""
            readOnly
            disabled
          />
          <div className="composer-box-actions">
            <span className="agent-map-demo-composer-note">
              Mock builder · no session or calls
            </span>
            <div className="composer-box-right">
              <button
                type="button"
                className="composer-send"
                disabled
                aria-label="Sending is unavailable in this snapshot"
              >
                <Icon name="ArrowUp" size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function builderStepIcon(step: AgentMapDemoBuilderStep): string {
  switch (step.kind) {
    case "contract":
      return "Code";
    case "data":
      return "Radio";
    case "decision":
      return "ListChecks";
    case "report":
    case "resource-boundary":
      return "BookOpen";
    case "owned-subagent":
      return "Sparkles";
    case "story":
      return "Pencil";
    case "media":
      return "Frame";
    case "connector-boundary":
      return "Plug";
  }
}

function BuilderStepsPane({
  session,
}: {
  session: AgentMapDemoBuilderSession;
}): JSX.Element {
  return (
    <>
      <header className="agent-map-demo-pane-header agent-map-demo-map-header">
        <span className="agent-map-demo-header-icon">
          <Icon name="ListChecks" size={15} />
        </span>
        <div className="agent-map-demo-header-copy">
          <span className="agent-map-demo-header-title">
            {session.agentLabel} · Steps
          </span>
          <span className="agent-map-demo-header-meta">
            Confirmed Agent Map revision 2
          </span>
        </div>
        <span className="status-tag agent-map-demo-map-status">
          <Icon name="FlaskConical" size={12} />
          Simulated structure
        </span>
      </header>

      <div
        className="canvas-steps-surface agent-map-demo-builder-steps"
        data-testid="agent-map-demo-builder-steps"
        data-builder-session={session.id}
      >
        <div className="agent-map-demo-builder-steps-intro">
          <div>
            <strong>Agent implementation plan</strong>
            <span className="status-tag">snapshot</span>
          </div>
          <p>
            Granular decomposition for this selected agent only. These are
            proposed steps, not live execution state.
          </p>
        </div>

        <div className="canvas-steps-list">
          <div className="canvas-steps-label">
            Steps
            <span className="canvas-steps-run-note">
              {session.steps.length} proposed · not running
            </span>
          </div>
          {session.steps.map((step, index) => (
            <div
              key={step.id}
              className={`canvas-step-item agent-map-demo-builder-step-item is-${step.kind}`}
              data-step-kind={step.kind}
            >
              <div
                className="canvas-step-row is-static agent-map-demo-builder-step-row"
                data-testid={`agent-map-demo-builder-step-${index + 1}`}
              >
                <span className="canvas-step-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="agent-map-demo-builder-step-icon">
                  <Icon name={builderStepIcon(step)} size={13} />
                </span>
                <span className="canvas-step-copy">
                  <span className="canvas-step-name">{step.label}</span>
                  <span className="canvas-step-role">Owner · {step.owner}</span>
                </span>
                <span
                  className={`canvas-step-meta status-tag agent-map-demo-builder-step-kind is-${step.kind}`}
                >
                  {step.kindLabel}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="agent-map-demo-builder-step-gate">
          <Icon name="MessageSquare" size={13} />
          <div>
            <strong>Planning checkpoint</strong>
            <span>Confirm or refine the five steps before implementation.</span>
          </div>
        </div>
      </div>
    </>
  );
}

function DemoTurn({
  turn,
  state,
}: {
  turn: AgentMapDemoTurn;
  state: AgentMapDemoState;
}): JSX.Element {
  const isPlanner = turn.role === "planner";
  return (
    <article
      className={
        "agent-map-demo-turn" + (isPlanner ? " is-planner" : " is-user")
      }
      data-testid={`agent-map-demo-turn-${turn.role}`}
    >
      <div className="agent-map-demo-turn-role">
        {isPlanner ? (
          <>
            <span className="agent-map-demo-planner-mark">
              <Icon name="Sparkles" size={12} />
            </span>
            <span>Planner</span>
            <span className="agent-map-demo-turn-meta">scripted</span>
          </>
        ) : (
          <span>You</span>
        )}
      </div>
      <div className="agent-map-demo-turn-body">
        {isPlanner ? <Markdown text={turn.body} /> : <p>{turn.body}</p>}
        {turn.kind === "proposal" && (
          <ProposalPreview editorIncluded={turn.body.includes("News Editor")} />
        )}
        {turn.kind === "confirmed" && (
          <ConfirmedRevision revision={state.revision} />
        )}
        {turn.kind === "build-plan" && (
          <BuildPlanPreview editorIncluded={state.editorIncluded} />
        )}
        {turn.kind === "builders-launched" && <SimulatedLaunchSummary />}
      </div>
    </article>
  );
}

function ProposalPreview({
  editorIncluded,
}: {
  editorIncluded: boolean;
}): JSX.Element {
  return (
    <div
      className="agent-map-demo-inline-card"
      data-testid="agent-map-demo-proposal-card"
      data-revision={editorIncluded ? "2" : "1"}
    >
      <div className="agent-map-demo-inline-card-head">
        <span>Architecture proposal</span>
        <span className="status-tag">revision {editorIncluded ? 2 : 1}</span>
      </div>
      <div className="agent-map-demo-handoff">
        <span>Market Research</span>
        <span className="agent-map-demo-relationship-chip">writes</span>
        <code>ResearchReport</code>
        <span className="agent-map-demo-relationship-chip">feeds</span>
        <span>{editorIncluded ? "News Editor" : "Marketing"}</span>
      </div>
      {editorIncluded && (
        <div className="agent-map-demo-inline-note">
          News Editor is owned inside Marketing / Publisher.
        </div>
      )}
    </div>
  );
}

function ConfirmedRevision({ revision }: { revision: number }): JSX.Element {
  return (
    <div
      className="agent-map-demo-inline-card is-confirmed"
      data-testid="agent-map-demo-confirmed-revision"
    >
      <span className="agent-map-demo-confirmed-icon">
        <Icon name="CircleCheck" size={15} />
      </span>
      <div>
        <strong>Revision {revision} confirmed</strong>
        <span>Exact proposal retained for the build plan</span>
      </div>
    </div>
  );
}

function BuildPlanPreview({
  editorIncluded,
}: {
  editorIncluded: boolean;
}): JSX.Element {
  return (
    <div
      className="agent-map-demo-build-plan"
      data-testid="agent-map-demo-build-plan"
    >
      <div className="agent-map-demo-inline-card-head">
        <span>Project build plan</span>
        <span className="status-tag">2 scoped builders</span>
      </div>
      <ol>
        <li>
          <span className="agent-map-demo-plan-number">01</span>
          <div>
            <strong>Market Research</strong>
            <span>
              Market scan, top-ten ranking, ResearchReport contract, and
              database write.
            </span>
          </div>
        </li>
        <li>
          <span className="agent-map-demo-plan-number">02</span>
          <div>
            <strong>Marketing / Publisher</strong>
            <span>
              {editorIncluded
                ? "Owned News Editor, editorial handoff, video production, and TikTok publish."
                : "Report intake, video production, and TikTok publish."}
            </span>
          </div>
        </li>
      </ol>
      <div className="agent-map-demo-plan-gate">
        <Icon name="GitBranch" size={13} />
        Handoff gate · ResearchReport validates before publishing work begins
      </div>
    </div>
  );
}

function SimulatedLaunchSummary(): JSX.Element {
  return (
    <div
      className="agent-map-demo-inline-card is-launched"
      data-testid="agent-map-demo-launch-summary"
    >
      <span className="agent-map-demo-launch-count">2</span>
      <div>
        <strong>Builder sessions staged</strong>
        <span>Local UI state only · nothing was created</span>
      </div>
    </div>
  );
}

function AgentMapPane({
  state,
  nodes,
  relationships,
  selectedNode,
  onSelectNode,
}: {
  state: AgentMapDemoState;
  nodes: readonly AgentMapDemoNode[];
  relationships: readonly AgentMapDemoRelationship[];
  selectedNode: AgentMapDemoNode | null;
  onSelectNode: (nodeId: AgentMapDemoNodeId | null) => void;
}): JSX.Element {
  const status = mapStatus(state);
  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  return (
    <>
      <header className="agent-map-demo-pane-header agent-map-demo-map-header">
        <span className="agent-map-demo-header-icon">
          <Icon name="Waypoints" size={15} />
        </span>
        <div className="agent-map-demo-header-copy">
          <span className="agent-map-demo-header-title">Agent Map</span>
          <span className="agent-map-demo-header-meta">Stock video desk</span>
        </div>
        <span
          className={`status-tag agent-map-demo-map-status is-${status.tone}`}
          data-testid="agent-map-demo-map-status"
        >
          {status.tone === "confirmed" ? (
            <Icon name="CircleCheck" size={12} />
          ) : status.tone === "staged" ? (
            <Icon name="Hammer" size={12} />
          ) : (
            <Icon name="Square" size={10} />
          )}
          {status.label}
        </span>
      </header>

      <div className="agent-map-demo-map-body" data-testid="agent-map-demo-map">
        <div
          className={
            "agent-map-demo-canvas-stage" +
            (nodes.length === 0 ? " is-empty" : "")
          }
          data-testid="agent-map-demo-canvas"
        >
          {nodes.length === 0 ? (
            <span className="visually-hidden">The Agent Map is empty.</span>
          ) : (
            <AgentMapGraph
              state={state}
              nodes={nodes}
              selectedNodeId={state.selectedNodeId}
              onSelectNode={onSelectNode}
            />
          )}
        </div>

        {selectedNode && (
          <NodeInspector
            state={state}
            node={selectedNode}
            nodeById={nodeById}
            relationships={relationships}
            onClose={() => onSelectNode(null)}
          />
        )}
      </div>
    </>
  );
}

function AgentMapGraph({
  state,
  nodes,
  selectedNodeId,
  onSelectNode,
}: {
  state: AgentMapDemoState;
  nodes: readonly AgentMapDemoNode[];
  selectedNodeId: AgentMapDemoNodeId | null;
  onSelectNode: (nodeId: AgentMapDemoNodeId) => void;
}): JSX.Element {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const marketing = nodeById.get("marketing-publisher");
  const editor = nodeById.get("news-editor");

  return (
    <div
      className="agent-map-demo-graph"
      data-testid="agent-map-demo-graph"
      data-revision={state.revision}
    >
      <svg
        className="agent-map-demo-edges"
        viewBox="0 0 1000 600"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="agent-map-demo-arrow"
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path d="M0,0 L7,3.5 L0,7 Z" />
          </marker>
        </defs>
        <path d="M400 142 C485 142 520 142 610 142" />
        <path d="M755 205 C755 305 565 310 395 386" />
        <path d="M520 454 C600 454 635 454 700 454" />
      </svg>

      <RelationshipLabel
        className="is-write"
        type="writes"
        contract="ResearchReport"
      />
      <RelationshipLabel
        className="is-feed"
        type="feeds"
        contract="ResearchReport"
      />
      <RelationshipLabel className="is-use" type="uses" />

      {nodeById.get("market-research") && (
        <MapNode
          node={nodeById.get("market-research")!}
          status={agentMapDemoNodeStatus(
            state,
            nodeById.get("market-research")!,
          )}
          selected={selectedNodeId === "market-research"}
          className="is-market-research"
          order={0}
          onSelect={onSelectNode}
        />
      )}
      {nodeById.get("research-database") && (
        <MapNode
          node={nodeById.get("research-database")!}
          status={agentMapDemoNodeStatus(
            state,
            nodeById.get("research-database")!,
          )}
          selected={selectedNodeId === "research-database"}
          className="is-research-database"
          order={1}
          onSelect={onSelectNode}
        />
      )}
      {marketing && (
        <div
          className={
            "agent-map-demo-marketing-group" +
            (selectedNodeId === marketing.id ? " is-selected" : "")
          }
          style={{ "--demo-node-order": 2 } as CSSProperties}
        >
          <button
            type="button"
            className="agent-map-demo-marketing-primary"
            data-testid={`agent-map-node-${marketing.id}`}
            aria-pressed={selectedNodeId === marketing.id}
            onClick={() => onSelectNode(marketing.id)}
          >
            <NodeHeading node={marketing} />
            <strong>{marketing.label}</strong>
            <span className="agent-map-demo-node-summary">
              {MAP_NODE_SUMMARIES[marketing.id]}
            </span>
            <NodeStatus status={agentMapDemoNodeStatus(state, marketing)} />
          </button>
          {editor && (
            <button
              type="button"
              className={
                "agent-map-demo-owned-node" +
                (selectedNodeId === editor.id ? " is-selected" : "")
              }
              data-testid={`agent-map-node-${editor.id}`}
              aria-pressed={selectedNodeId === editor.id}
              onClick={() => onSelectNode(editor.id)}
            >
              <span className="agent-map-demo-owned-node-icon">
                <Icon name="Sparkles" size={12} />
              </span>
              <span className="agent-map-demo-owned-node-copy">
                <strong>{editor.label}</strong>
                <span>Owned subagent · selects strongest points</span>
              </span>
              <span className="agent-map-demo-owned-flow">feeds</span>
            </button>
          )}
        </div>
      )}
      {nodeById.get("tiktok") && (
        <MapNode
          node={nodeById.get("tiktok")!}
          status={agentMapDemoNodeStatus(state, nodeById.get("tiktok")!)}
          selected={selectedNodeId === "tiktok"}
          className="is-tiktok"
          order={3}
          onSelect={onSelectNode}
        />
      )}
    </div>
  );
}

function RelationshipLabel({
  className,
  type,
  contract,
}: {
  className: string;
  type: AgentMapDemoRelationship["type"];
  contract?: string;
}): JSX.Element {
  return (
    <div className={`agent-map-demo-edge-label ${className}`}>
      <span>{type}</span>
      {contract && <code>{contract}</code>}
    </div>
  );
}

function MapNode({
  node,
  status,
  selected,
  className,
  order,
  onSelect,
}: {
  node: AgentMapDemoNode;
  status: ReturnType<typeof agentMapDemoNodeStatus>;
  selected: boolean;
  className: string;
  order: number;
  onSelect: (nodeId: AgentMapDemoNodeId) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={
        `agent-map-demo-node is-${node.kind.toLocaleLowerCase().replace(/\s+/g, "-")} ${className}` +
        (selected ? " is-selected" : "")
      }
      style={{ "--demo-node-order": order } as CSSProperties}
      data-testid={`agent-map-node-${node.id}`}
      aria-pressed={selected}
      onClick={() => onSelect(node.id)}
    >
      <NodeHeading node={node} />
      <strong>{node.label}</strong>
      <span className="agent-map-demo-node-summary">
        {MAP_NODE_SUMMARIES[node.id]}
      </span>
      <NodeStatus status={status} />
    </button>
  );
}

function NodeHeading({ node }: { node: AgentMapDemoNode }): JSX.Element {
  return (
    <span className="agent-map-demo-node-heading">
      <span className="agent-map-demo-node-icon">
        <Icon name={NODE_ICONS[node.kind]} size={13} />
      </span>
      <span>{node.kind}</span>
    </span>
  );
}

function NodeStatus({
  status,
}: {
  status: ReturnType<typeof agentMapDemoNodeStatus>;
}): JSX.Element {
  return (
    <span
      className={`status-tag agent-map-demo-node-status is-${status.replace(/\s+/g, "-")}`}
    >
      <span className="status-tag-dot" />
      {status}
    </span>
  );
}

function NodeInspector({
  state,
  node,
  nodeById,
  relationships,
  onClose,
}: {
  state: AgentMapDemoState;
  node: AgentMapDemoNode;
  nodeById: ReadonlyMap<AgentMapDemoNodeId, AgentMapDemoNode>;
  relationships: readonly AgentMapDemoRelationship[];
  onClose: () => void;
}): JSX.Element {
  const relevant = relationships.filter(
    (relationship) =>
      relationship.from === node.id || relationship.to === node.id,
  );
  const owner = node.ownerId ? nodeById.get(node.ownerId) : null;

  return (
    <aside
      className="agent-map-demo-inspector"
      data-testid="agent-map-demo-inspector"
      aria-label={`${node.label} inspector`}
    >
      <div className="agent-map-demo-inspector-head">
        <span className="agent-map-demo-inspector-icon">
          <Icon name={NODE_ICONS[node.kind]} size={15} />
        </span>
        <div>
          <span className="agent-map-demo-inspector-kind">{node.kind}</span>
          <h2>{node.label}</h2>
        </div>
        <button
          type="button"
          className="theme-toggle"
          data-testid="agent-map-demo-inspector-close"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <Icon name="X" size={14} />
        </button>
      </div>

      <div className="agent-map-demo-inspector-body">
        <dl>
          <div>
            <dt>Kind</dt>
            <dd>{node.kind}</dd>
          </div>
          <div>
            <dt>Purpose</dt>
            <dd>{node.purpose}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <NodeStatus status={agentMapDemoNodeStatus(state, node)} />
            </dd>
          </div>
          {owner && (
            <div>
              <dt>Owner</dt>
              <dd>{owner.label}</dd>
            </div>
          )}
        </dl>

        <section className="agent-map-demo-inspector-relationships">
          <h3>Relationships</h3>
          <ul>
            {relevant.map((relationship) => {
              const outgoing = relationship.from === node.id;
              const other = nodeById.get(
                outgoing ? relationship.to : relationship.from,
              );
              return (
                <li key={relationship.id}>
                  <span className="agent-map-demo-relationship-direction">
                    {outgoing ? "Outbound" : "Inbound"}
                  </span>
                  <span className="agent-map-demo-relationship-line">
                    <span>{outgoing ? node.label : other?.label}</span>
                    <Icon name="ArrowRight" size={12} />
                    <span className="agent-map-demo-relationship-chip">
                      {relationship.type}
                    </span>
                    <Icon name="ArrowRight" size={12} />
                    <span>{outgoing ? other?.label : node.label}</span>
                  </span>
                  {relationship.contract && (
                    <code>{relationship.contract}</code>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </aside>
  );
}
