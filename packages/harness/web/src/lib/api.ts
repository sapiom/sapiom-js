/**
 * Typed REST client for the harness server (see the "REST API surface"
 * section of ../../../src/shared/types.ts). Gated at this layer: with
 * `VITE_MOCK=1` the whole app runs against in-memory fixtures and never
 * touches the network — this is what lets the SPA build ahead of a running
 * server.
 */
import type {
  AccountPlanView,
  AdoptSessionRequest,
  AgentScaffoldResponse,
  AppState,
  AttachFileRequest,
  AttachFileResponse,
  BindWorkflowRequest,
  CreateSessionRequest,
  FsDirEntry,
  FsListResponse,
  HarnessEntry,
  HarnessSession,
  HarnessSettings,
  InjectInputRequest,
  MacroDef,
  RunMacroRequest,
  SessionRecord,
  SessionSummary,
  StudioRailFileResponse,
  StudioRailLaunchEdge,
  StudioRailLaunchEdgesResponse,
  TemplateDetailView,
  TemplateListResponse,
  RunView,
  StepView,
  WorkflowInputContractResponse,
  WorkflowInfo,
} from "@shared/types";
import {
  type SystemGraph,
  type SystemGraphNavigationResponse,
  type SystemGraphSnapshot,
  type WorkspaceKey,
  type WorkspaceScopeSummary,
} from "@shared/system-graph";
import type {
  AgentMapWorkspaceResponse,
  PlannerMessageRequest,
  PlannerSessionMetadataResponse,
  PlannerSessionRequest,
  PlannerSessionResponse,
  PutStudioCurrentWorkspaceRequest,
  StudioCurrentWorkspaceResponse,
  StudioProjectId,
  StudioProjectSummary,
  StudioWorkspaceSelection,
} from "@shared/agent-map";

import type { LocalStepTrace, LocalRunOutcome } from "@sapiom/agent-core";

import { getTheme } from "./theme";
import { refuseAgentName } from "@shared/agent-name";
import {
  parseSystemGraphNavigation,
  parseSystemGraphSnapshot,
} from "./system-graph";
import {
  parseAgentMapWorkspaceResponse,
  parseStudioCurrentWorkspaceResponse,
} from "./agent-map";
import { refuseMove, remapUnder } from "./agent-move";
import { basenameOf, isWithinDir, parentOf, samePath } from "./paths";

import type { CanvasGraph, CanvasGraphNode } from "./canvas-graph";
import {
  MOCK_ACCOUNT_PLAN,
  MOCK_FS_TREE,
  MOCK_HARNESSES,
  MOCK_HISTORY,
  MOCK_LAUNCH_DIR,
  MOCK_MACROS,
  MOCK_SEARCH_HISTORY,
  MOCK_SEARCH_WORKFLOWS,
  MOCK_SESSION_RECORDS,
  MOCK_SESSIONS,
  MOCK_SETTINGS,
  MOCK_TEMPLATE_GRAPHS,
  MOCK_TEMPLATES,
  MOCK_WORKFLOWS,
} from "./mock-data";

/**
 * Body for `POST /api/runs/local` — run the agent project at `sourceDir` with
 * Sapiom capability calls served by stubs. `sourceDir` is the only required
 * field; the rest are forwarded to the run-local bootstrap as-is. The runner
 * needs no API key and makes no Sapiom capability request; arbitrary user step
 * code still executes locally and may use the machine's network. Mirrors the
 * server's `RunLocalRequest` without importing it into the browser bundle.
 */
export interface RunLocalArgs {
  /** Absolute path to the agent project directory (contains `index.ts`). */
  sourceDir: string;
  /** The workflow's entry-step input (optional; agent-core defaults it). */
  input?: unknown;
  /** Explicit per-capability stub overrides; omitted → the project's committed
   *  dev stubs are used. Left as an opaque record here — the SPA only forwards
   *  it, agent-core owns the schema. */
  stubs?: unknown;
  /** Per-step attempt cap (optional; agent-core defaults it). */
  maxAttemptsPerStep?: number;
}

/**
 * One parsed line of the `/api/runs/local` NDJSON stream. Either a per-step
 * trace wrapped with its start/settle phase, a legacy unwrapped trace
 * (discriminated by the absence of `kind`), or a terminal line: a `summary`
 * for a run that executed (carrying the outcome and
 * the two stub-hygiene signals), or an `error` for a run that could not be
 * invoked at all. The shapes mirror the bootstrap's own wire contract.
 */
export type RunLocalLine =
  | ({ kind?: undefined } & LocalStepTrace)
  | {
      kind: "step";
      phase: "started" | "settled";
      trace: LocalStepTrace;
    }
  | {
      kind: "summary";
      outcome: LocalRunOutcome;
      output?: unknown;
      error?: unknown;
      unusedStubs?: Array<{ step: string; key: string }>;
      stubWarnings?: string[];
    }
  | { kind: "error"; outcome: "failed"; error: string };

// ---------------------------------------------------------------------------
// Direct-action wire shapes (matched to src/server/actions.ts). SPA-only — the
// browser consumes these streams but never the server modules that emit them,
// so they live here rather than in shared/types.ts.
// ---------------------------------------------------------------------------

/**
 * One line of the `POST /api/workflows/:id/deploy` NDJSON stream (mirrors
 * `DeployStreamEvent` in src/server/actions.ts): an optional `linking` line
 * when the server has to resolve-or-create the remote agent first, an
 * optional `warning` line (non-terminal, advisory — the agent was created but
 * its id couldn't be written back to sapiom.json), a `building` line, then
 * exactly one terminal `ready` | `error` line closing the stream.
 */
export type DeployStreamEvent =
  | { phase: "linking"; name: string }
  | { phase: "warning"; message: string }
  | { phase: "building"; definitionId: string }
  | { phase: "ready"; definitionId: string; buildRunId: string; status: string }
  | { phase: "error"; code: string; message: string; hint?: string };

/** The `POST /api/runs` response — the started prod execution's id, which the
 *  live-canvas path then polls via `getRunState`. */
export interface RunResponse {
  executionId: string;
}

/** Callback fired once per NDJSON line as a direct-action stream is consumed. */
export type StreamLineHandler<T> = (line: T) => void;

export type { FsDirEntry, FsListResponse };

export function isMockMode(): boolean {
  return import.meta.env.VITE_MOCK === "1";
}

/**
 * Mock mode only: `?mockState=fresh` renders the app as a brand-new install
 * (no sessions, no recent dirs, no workflows, firstRun set) instead of the
 * lived-in default fixtures — this is how Playwright exercises the first-run
 * welcome panel without a real server.
 */
export function isFreshMockState(): boolean {
  return (
    isMockMode() &&
    new URLSearchParams(window.location.search).get("mockState") === "fresh"
  );
}

/**
 * Mock mode only: `?mockFixtures=search` additionally seeds the shapes from
 * the search bug report (a scoped agent name, a scatter-path agent, duplicate
 * and raw-prompt history titles) so Playwright can exercise the palette's
 * ranking. Additive-only, so every fixture-count assertion elsewhere holds.
 */
export function isSearchFixturesEnabled(): boolean {
  return (
    isMockMode() &&
    new URLSearchParams(window.location.search).get("mockFixtures") === "search"
  );
}

/** The mock session the demo seed drives (the auto-created boot session). */
export const DEMO_SESSION_ID = "sess-boot";

/**
 * Mock mode only: whether to seed the first-load DEMO end-state — a completed
 * prod run for the boot session (lighting Steps and a chat receipt) plus the
 * auto-played mapping conversation. On by default so a bare
 * load shows the real product story; tests that exercise mechanics from a
 * clean slate opt out with `?seed=0`, and the fresh-install state has no boot
 * session to seed.
 */
export function isDemoSeedEnabled(): boolean {
  if (!isMockMode() || typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("seed") !== "0" && params.get("mockState") !== "fresh";
}

/**
 * Mock mode only: `?mockError=listDir` forces the named operations to
 * reject, so Playwright can exercise the error states of surfaces that talk to
 * the filesystem API (directory picker, command-palette path mode) without a
 * real server. Comma-separated; unknown names ignored.
 */
export function mockErrorTargets(): Set<string> {
  if (!isMockMode()) return new Set();
  const raw =
    new URLSearchParams(window.location.search).get("mockError") ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** `session.boundWorkflowPath` is nullable already, but keeps callers safe against a missing session. */
export function boundWorkflowPathOf(
  session: HarnessSession | null | undefined,
): string | null {
  return session?.boundWorkflowPath ?? null;
}

/**
 * Thrown by `RealApi.request()` for any non-2xx response. `.message` keeps
 * the full "METHOD path → status: body" shape for logs/devtools; `.reason`
 * is the server's own `{ error: "..." }` message when the body parses as
 * that shape (e.g. `SessionNotReadyError`'s UI-facing text) — callers that
 * want to show something a user should actually read (not a debug string)
 * should prefer `.reason` and fall back to `.message`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, message: string, reason: string | undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The sentence to SHOW for a failed request.
 *
 * `ApiError.message` is the wire shape — `POST /api/agents/scaffold → 409:
 * {"error":"…"}` — which is right for a log and wrong in a dialog: measured on
 * a real server, the create dialog showed the user a JSON body inside a status
 * line. `.reason` is the server's own sentence, written to be read, so every
 * user-facing catch prefers it. The fallback covers a non-Error rejection and a
 * response that was not JSON.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.reason ?? err.message ?? fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Read the boot token injected only into a UI-credential-authorized HTML response. */
export function getBootToken(): string {
  const injected = (window as unknown as { __HARNESS__?: { token?: string } })
    .__HARNESS__;
  if (injected?.token) return injected.token;
  return "";
}

/** Response from GET /api/auth/status — live auth state from the server. */
/** Why a workflow-keyed board is not a graph. `ok` is the only status carrying one. */
export type WorkflowGraphStatus = "ok" | "empty" | "preparing" | "error";

/**
 * `GET /api/workflows/:path/graph` — the SESSION-FREE canvas entry point
 * (IA-01; contract in `packages/harness/docs/agent-canvas-graph.md`).
 *
 * Declared here rather than imported from `src/server/workflow-graph.ts`: that
 * module reaches for `node:path` and `express`, so the browser cannot see it.
 * `enrichment` stays `unknown` because nothing client-side reads it yet — the
 * pane draws `document` and inspects `graph`.
 *
 * The route returns JSON and CANNOT be an `<iframe src>`: it sits behind the
 * `X-Harness-Token` middleware and a bare `src` carries no header. `document`
 * is byte-identical to what a bound session's `/canvas/:sessionId/` serves for
 * the same workflow, and is present for EVERY status — an empty board is still
 * a renderable page, never a hole — so a consumer renders it via `srcdoc`.
 */
export interface WorkflowGraphResponse {
  /** The resolved absolute agent directory the board was derived from. */
  path: string;
  /** The registry's display name — the board's panel title. */
  name: string;
  status: WorkflowGraphStatus;
  /** The extracted graph; null for every status but "ok". */
  graph: CanvasGraph | null;
  enrichment: unknown | null;
  /** Human-readable explanation for "empty"/"error"; null otherwise. */
  reason: string | null;
  /** True when the graph came from the extraction cache — no child process ran. */
  cached: boolean;
  document: string;
}

export interface AuthStatusResponse {
  authenticated: boolean;
  organizationName: string | null;
}

/** Response from POST /api/auth/start — async kick-off only. */
export interface AuthStartResponse {
  started: boolean;
}

/** What a requested scan found, and what it deliberately did not enter. */
export interface WorkflowScanOutcome {
  found: WorkflowInfo[];
  /** Absolute paths of checkouts the walk stopped at rather than entering. */
  repositoryBoundaries: string[];
}

/**
 * Roots whose scan stops at checkouts, keyed by root — mock mode's stand-in for
 * a folder full of clones. Keyed rather than derived so a spec can point at one
 * deliberately.
 */
const MOCK_SCAN_BOUNDARIES: Record<string, string[]> = {
  "/Users/demo/src": ["/Users/demo/src/clone-a", "/Users/demo/src/clone-b"],
};

export interface HarnessApi {
  /**
   * Kick off the browser OAuth flow (`POST /api/auth/start`). Returns
   * immediately with `{ started: true }` — the actual sign-in is async and
   * completes via the `auth.changed` event bus message (or by polling
   * `authStatus()`). A 409 response means a sign-in is already in progress.
   */
  startAuth(): Promise<AuthStartResponse>;
  /**
   * Sign out and clear stored credentials (`POST /api/auth/disconnect`).
   * Resolves with `{ ok: true }` on success. If a sign-in is in flight on the
   * server, it will be cancelled.
   */
  disconnect(): Promise<{ ok: true }>;
  /**
   * Query the live auth state (`GET /api/auth/status`). Use this to poll for
   * sign-in completion if the `auth.changed` bus message is unavailable, or as
   * a one-shot check on mount.
   */
  authStatus(): Promise<AuthStatusResponse>;
  getState(): Promise<AppState>;
  /** Durable, path-free empty/proposal/revision pointers for one Studio project. */
  getAgentMapWorkspace(
    projectId: StudioProjectId,
  ): Promise<AgentMapWorkspaceResponse>;
  getStudioCurrentWorkspace(
    projectId: StudioProjectId,
  ): Promise<StudioCurrentWorkspaceResponse>;
  putStudioCurrentWorkspace(
    projectId: StudioProjectId,
    selection: StudioWorkspaceSelection,
  ): Promise<StudioCurrentWorkspaceResponse>;
  openPlannerSession(
    projectId: StudioProjectId,
    request: PlannerSessionRequest,
  ): Promise<PlannerSessionResponse>;
  sendPlannerMessage(
    projectId: StudioProjectId,
    sessionId: string,
    request: PlannerMessageRequest,
  ): Promise<PlannerSessionMetadataResponse>;
  retryPlannerGreeting(
    projectId: StudioProjectId,
    sessionId: string,
  ): Promise<PlannerSessionMetadataResponse>;
  /** Revisioned local dependency projection for one server-issued workspace key. */
  getSystemGraph(
    workspaceKey: WorkspaceKey,
    options?: { refresh?: boolean },
  ): Promise<SystemGraphSnapshot>;
  /** Server-owned AgentKey resolver for one exact graph revision. */
  getSystemGraphNavigation(
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphNavigationResponse>;
  createSession(req: CreateSessionRequest): Promise<HarnessSession>;
  attachFile(id: string, req: AttachFileRequest): Promise<AttachFileResponse>;
  listSessions(): Promise<HarnessSession[]>;
  sessionHistory(cwd: string): Promise<SessionSummary[]>;
  /**
   * A past session's transcript, RECONSTRUCTED from the harness's own recorded
   * events (`GET /api/sessions/:id/record`) — not a verbatim replay, and not
   * the agent's own transcript file. `id` is a harnessSessionId, or the agent's
   * session id for history rows the registry never tracked. Resolves null when
   * the server has no recorded events for it (404) or predates the route (501)
   * — both are "nothing to show", not an error worth a toast.
   */
  sessionRecord(id: string): Promise<SessionRecord | null>;
  resumeSession(id: string): Promise<HarnessSession>;
  /** Take a transcript-only history row (`resumeMode: "agent-resume"`, no
   *  `harnessSessionId`) into the registry and resume it — the honest
   *  alternative to silently opening a fresh session in its directory.
   *  Rejects 409 `SESSION_NOT_RESUMEABLE` if the server's own re-check finds
   *  the agent no longer holds the conversation. */
  adoptSession(req: AdoptSessionRequest): Promise<HarnessSession>;
  killSession(id: string): Promise<void>;
  injectInput(id: string, req: InjectInputRequest): Promise<void>;
  listWorkflows(): Promise<WorkflowInfo[]>;
  /** Entry-step JSON Schema used by Studio's unified run sheet. */
  getWorkflowInputContract(
    workflowPath: string,
  ): Promise<WorkflowInputContractResponse>;
  /**
   * The workflow-keyed canvas board (IA-01) — the only way to read agent F's
   * board while the active session is bound to agent B, and the only board an
   * agent that has never hosted a session has at all.
   *
   * Rejects with `ApiError(404)` when the path is not a registered workflow and
   * `ApiError(400)` for a rejected path shape. A registered agent with no
   * usable `sapiom.json` resolves `200` with `status: "empty"` — absent means
   * empty, never missing — so a consumer must tell a real board from an empty
   * one by `status`, never by the status code.
   */
  getWorkflowGraph(workflowPath: string): Promise<WorkflowGraphResponse>;
  connectWorkflow(path: string): Promise<WorkflowInfo>;
  /**
   * `POST /api/workflows/scan` — a requested deep scan of one root.
   *
   * Returns the OUTCOME, not a bare array. `found` alone is not enough to
   * describe what happened: the walk stops at a foreign repository root, so
   * scanning a folder that is not itself a repo but holds several clones finds
   * nothing while several agents sit on disk. `repositoryBoundaries` is what
   * lets the rail say "these checkouts were not searched" instead of "this
   * folder is empty" — the difference between a true and a false statement.
   */
  scanWorkflows(root: string): Promise<WorkflowScanOutcome>;
  /**
   * Moves an agent's DIRECTORY on disk — the Project axis's drag (SAP-2930).
   *
   * The Project axis is derived from real paths, so a drag has two honest
   * outcomes: move, or refuse. Rejects with an `ApiError` carrying the server's
   * reason when the destination is occupied or the move is impossible; the
   * server guards independently of the rail's `planMove`, so a refusal can
   * arrive even for a plan the rail blessed. On success the server broadcasts
   * `workflows.changed` and the rail re-derives the tree from the new path.
   */
  moveAgent(from: string, to: string): Promise<void>;
  /**
   * Creates an agent on disk — the create flow's ONE mechanism (SAP-2981).
   *
   * The harness does the scaffold; nothing here asks a coding agent to perform
   * a filesystem operation by natural language. So a failure is an `ApiError`
   * carrying the server's own sentence (a name already taken in that project,
   * a name that is not one folder segment, a root the rail cannot show) — a
   * thing the dialog can show — instead of a prompt whose outcome only the
   * terminal knows. Resolves once the agent is on disk AND the server has
   * rescanned it into the registry, so the rail can show it before any session
   * opens.
   */
  scaffoldAgent(
    root: string,
    name: string,
    template?: string,
  ): Promise<AgentScaffoldResponse>;
  /** Adapter registry (GET /api/harnesses): every known harness with its
   *  mode/installed/experimental flags plus per-agent Sapiom MCP install
   *  instructions — the new-session picker and MCP setup block feed on it. */
  listHarnesses(): Promise<HarnessEntry[]>;
  /**
   * The Group axis's stored arrangement for one project root — the exact text of
   * `<root>/.sapiom/studio-rail.json`, or null when there is no file.
   *
   * TEXT, not a decoded object, and deliberately so: the file distinguishes
   * `groups: null` ("nothing stored, detection owns this") from `groups: []`
   * ("the user materialized groups and then deleted them all"), and a second
   * decoder anywhere on this path is a second place for those to collapse into
   * each other. `lib/agent-groups.ts` is the only decoder.
   */
  getRailState(projectRoot: string): Promise<string | null>;
  /** Write a MATERIALIZED arrangement. An un-materialized one is
   *  `clearRailState`, never `{ groups: [] }`. */
  saveRailState(projectRoot: string, raw: string): Promise<void>;
  /** Remove the file: how an un-materialized arrangement — including the one
   *  `Reset to detected` produces — is persisted. Removing rather than skipping
   *  the write is what stops the old arrangement outliving the reset. */
  clearRailState(projectRoot: string): Promise<void>;
  /** Every detected launch edge across the registered agents, from the existing
   *  grep in `core/canvas-interconnections.ts`. The Group axis seeds its groups
   *  from the connected components over these. */
  listLaunchEdges(): Promise<StudioRailLaunchEdge[]>;
  listMacros(): Promise<MacroDef[]>;
  runMacro(id: string, req: RunMacroRequest): Promise<void>;
  getSettings(): Promise<HarnessSettings>;
  updateSettings(patch: Partial<HarnessSettings>): Promise<HarnessSettings>;
  listDir(path?: string): Promise<FsListResponse>;
  bindWorkflow(
    sessionId: string,
    workflowPath: string | null,
  ): Promise<HarnessSession>;
  /** The live template gallery, relayed by the server from core (key stays
   *  server-side). Never rejects on a degraded catalog — inspect `source`. */
  listTemplates(): Promise<TemplateListResponse>;
  /** One template's manifest + declared graph. Rejects 404 on an unknown id. */
  getTemplate(id: string): Promise<TemplateDetailView>;
  /** The rail's plan card view, relayed by the server from core (key stays
   *  server-side). Never rejects on a degraded read — inspect `source`. */
  getAccountPlan(): Promise<AccountPlanView>;
  /** Live run render state (upstream feat/harness-runtime-analytics):
   *  GET /api/runs/:id/state = inspect -> decode -> renderRunState. Poll
   *  after an execution.started bus message until the run is terminal. */
  getRunState(executionId: string): Promise<RunView>;
  /**
   * Run the workflow at `args.sourceDir` locally against stub capabilities and
   * stream its NDJSON result (`POST /api/runs/local`): `onLine` is called once
   * per parsed line, in order — each per-step {@link LocalStepTrace} as it
   * arrives, then a terminal `summary` (or `error`) line. Resolves when the
   * stream ends; rejects only on a transport failure (never on a failed *run* —
   * a failed run is a normal terminal line). It needs no Sapiom key and creates
   * no Sapiom capability spend; author code's own side effects remain real.
   */
  runLocal(
    args: RunLocalArgs,
    onLine: (line: RunLocalLine) => void,
  ): Promise<void>;
  /**
   * Deploy the agent linked to `workflowPath` (Deploy button) — POST
   * /api/workflows/:id/deploy. The server holds the API key and drives the
   * build; NO Claude Code, no user LLM credits. `onEvent` fires per NDJSON
   * line as the build streams (`building` → terminal `ready`/`error`); the
   * promise resolves with the terminal event. Rejects (ApiError) only on the
   * request itself failing (e.g. 409 not-linked) — a build *failure* resolves
   * with a `phase: "error"` terminal event, since the request succeeded.
   */
  deploy(
    workflowPath: string,
    onEvent?: StreamLineHandler<DeployStreamEvent>,
  ): Promise<DeployStreamEvent>;
  /**
   * Start a real prod execution (Prod-run button) — POST /api/runs. Runs
   * server-side with the held key; NO Claude Code. Returns the new
   * `{ executionId }`, which the caller hands to the run-inspector poller.
   */
  run(req: { definitionId: string; input?: unknown }): Promise<RunResponse>;
}

class RealApi implements HarnessApi {
  startAuth(): Promise<AuthStartResponse> {
    return this.request<AuthStartResponse>("/api/auth/start", {
      method: "POST",
    });
  }

  disconnect(): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/api/auth/disconnect", {
      method: "POST",
    });
  }

  authStatus(): Promise<AuthStatusResponse> {
    return this.request<AuthStatusResponse>("/api/auth/status");
  }

  private async response(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": getBootToken(),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let reason: string | undefined;
      try {
        const parsed: unknown = body ? JSON.parse(body) : undefined;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { error?: unknown }).error === "string"
        ) {
          reason = (parsed as { error: string }).error;
        }
      } catch {
        // Not JSON — reason stays undefined, callers fall back to .message.
      }
      throw new ApiError(
        res.status,
        `${init?.method ?? "GET"} ${path} → ${res.status}${body ? `: ${body}` : ""}`,
        reason,
      );
    }
    return res;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.response(path, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  getState(): Promise<AppState> {
    return this.request<AppState>("/api/state");
  }

  async getAgentMapWorkspace(
    projectId: StudioProjectId,
  ): Promise<AgentMapWorkspaceResponse> {
    const value = await this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/agent-map/workspace`,
    );
    return parseAgentMapWorkspaceResponse(value, projectId);
  }

  async getStudioCurrentWorkspace(
    projectId: StudioProjectId,
  ): Promise<StudioCurrentWorkspaceResponse> {
    const value = await this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/current-workspace`,
    );
    return parseStudioCurrentWorkspaceResponse(value, projectId);
  }

  async putStudioCurrentWorkspace(
    projectId: StudioProjectId,
    selection: StudioWorkspaceSelection,
  ): Promise<StudioCurrentWorkspaceResponse> {
    const value = await this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/current-workspace`,
      {
        method: "PUT",
        body: JSON.stringify({
          selection,
        } satisfies PutStudioCurrentWorkspaceRequest),
      },
    );
    return parseStudioCurrentWorkspaceResponse(value, projectId);
  }

  openPlannerSession(
    projectId: StudioProjectId,
    request: PlannerSessionRequest,
  ): Promise<PlannerSessionResponse> {
    return this.request<PlannerSessionResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/planner-sessions`,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  async sendPlannerMessage(
    projectId: StudioProjectId,
    sessionId: string,
    request: PlannerMessageRequest,
  ): Promise<PlannerSessionMetadataResponse> {
    return this.request<PlannerSessionMetadataResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/planner-sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  async retryPlannerGreeting(
    projectId: StudioProjectId,
    sessionId: string,
  ): Promise<PlannerSessionMetadataResponse> {
    return this.request<PlannerSessionMetadataResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/planner-sessions/${encodeURIComponent(sessionId)}/greeting/retry`,
      { method: "POST", body: "{}" },
    );
  }

  async getSystemGraph(
    workspaceKey: WorkspaceKey,
    options: { refresh?: boolean } = {},
  ): Promise<SystemGraphSnapshot> {
    const route = `/api/workspaces/${encodeURIComponent(workspaceKey)}/system-graph`;
    const response = await this.response(
      options.refresh ? `${route}/refresh` : route,
      options.refresh ? { method: "POST" } : undefined,
    );
    const snapshot = parseSystemGraphSnapshot(
      (await response.json()) as unknown,
    );
    if (snapshot.workspaceKey !== workspaceKey) {
      throw new Error("Invalid system graph response");
    }
    return snapshot;
  }

  async getSystemGraphNavigation(
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphNavigationResponse> {
    const value = await this.request<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceKey)}/system-graph/navigation`,
    );
    return parseSystemGraphNavigation(value, { workspaceKey });
  }

  createSession(req: CreateSessionRequest): Promise<HarnessSession> {
    // Default the launch theme to the app's live theme so the terminal palette
    // controls Claude's colors (Terminal.tsx). An explicit req.theme still wins.
    return this.request<HarnessSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ theme: getTheme(), ...req }),
    });
  }

  attachFile(id: string, req: AttachFileRequest): Promise<AttachFileResponse> {
    return this.request<AttachFileResponse>(
      `/api/sessions/${encodeURIComponent(id)}/attachments`,
      {
        method: "POST",
        body: JSON.stringify(req),
      },
    );
  }

  listSessions(): Promise<HarnessSession[]> {
    return this.request<HarnessSession[]>("/api/sessions");
  }

  sessionHistory(cwd: string): Promise<SessionSummary[]> {
    return this.request<SessionSummary[]>(
      `/api/sessions/history?cwd=${encodeURIComponent(cwd)}`,
    );
  }

  async sessionRecord(id: string): Promise<SessionRecord | null> {
    try {
      return await this.request<SessionRecord>(
        `/api/sessions/${encodeURIComponent(id)}/record`,
      );
    } catch (err) {
      // 404 = no events recorded for this session; 501 = an older server with
      // no record route at all. Both mean "there is no transcript to show",
      // which the pane renders as an empty state — not a failure.
      if (err instanceof ApiError && (err.status === 404 || err.status === 501))
        return null;
      throw err;
    }
  }

  resumeSession(id: string): Promise<HarnessSession> {
    return this.request<HarnessSession>(
      `/api/sessions/${encodeURIComponent(id)}/resume`,
      { method: "POST" },
    );
  }

  adoptSession(req: AdoptSessionRequest): Promise<HarnessSession> {
    return this.request<HarnessSession>("/api/sessions/adopt", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async killSession(id: string): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async injectInput(id: string, req: InjectInputRequest): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(id)}/input`,
      {
        method: "POST",
        body: JSON.stringify(req),
      },
    );
  }

  listWorkflows(): Promise<WorkflowInfo[]> {
    return this.request<WorkflowInfo[]>("/api/workflows");
  }

  getWorkflowInputContract(
    workflowPath: string,
  ): Promise<WorkflowInputContractResponse> {
    return this.request<WorkflowInputContractResponse>(
      `/api/workflows/${encodeURIComponent(workflowPath)}/input-contract`,
    );
  }

  getWorkflowGraph(workflowPath: string): Promise<WorkflowGraphResponse> {
    // Same encoding as `input-contract` and `deploy` beside it: the agent's
    // absolute path URI-encoded into ONE segment. Express matches on the raw
    // path and decodes the param, so an encoded `/` never splits the route.
    return this.request<WorkflowGraphResponse>(
      `/api/workflows/${encodeURIComponent(workflowPath)}/graph`,
    );
  }

  connectWorkflow(path: string): Promise<WorkflowInfo> {
    return this.request<WorkflowInfo>("/api/workflows/connect", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  scanWorkflows(root: string): Promise<WorkflowScanOutcome> {
    return this.request<WorkflowScanOutcome>("/api/workflows/scan", {
      method: "POST",
      body: JSON.stringify({ root }),
    });
  }

  async moveAgent(from: string, to: string): Promise<void> {
    await this.request<{ ok: true }>("/api/agents/move", {
      method: "POST",
      body: JSON.stringify({ from, to }),
    });
  }

  scaffoldAgent(
    root: string,
    name: string,
    template?: string,
  ): Promise<AgentScaffoldResponse> {
    return this.request<AgentScaffoldResponse>("/api/agents/scaffold", {
      method: "POST",
      body: JSON.stringify({ root, name, template }),
    });
  }

  listHarnesses(): Promise<HarnessEntry[]> {
    return this.request<HarnessEntry[]>("/api/harnesses");
  }

  async getRailState(projectRoot: string): Promise<string | null> {
    const res = await this.request<StudioRailFileResponse>(
      `/api/studio-rail?root=${encodeURIComponent(projectRoot)}`,
    );
    return res.raw;
  }

  async saveRailState(projectRoot: string, raw: string): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/studio-rail?root=${encodeURIComponent(projectRoot)}`,
      { method: "PUT", body: JSON.stringify({ raw }) },
    );
  }

  async clearRailState(projectRoot: string): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/studio-rail?root=${encodeURIComponent(projectRoot)}`,
      { method: "DELETE" },
    );
  }

  async listLaunchEdges(): Promise<StudioRailLaunchEdge[]> {
    const res = await this.request<StudioRailLaunchEdgesResponse>(
      "/api/studio-rail/launch-edges",
    );
    return res.edges;
  }

  listMacros(): Promise<MacroDef[]> {
    return this.request<MacroDef[]>("/api/macros");
  }

  async runMacro(id: string, req: RunMacroRequest): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/macros/${encodeURIComponent(id)}/run`,
      {
        method: "POST",
        body: JSON.stringify(req),
      },
    );
  }

  getSettings(): Promise<HarnessSettings> {
    return this.request<HarnessSettings>("/api/settings");
  }

  updateSettings(patch: Partial<HarnessSettings>): Promise<HarnessSettings> {
    return this.request<HarnessSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  listDir(path?: string): Promise<FsListResponse> {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.request<FsListResponse>(`/api/fs/list${query}`);
  }

  bindWorkflow(
    sessionId: string,
    workflowPath: string | null,
  ): Promise<HarnessSession> {
    const body: BindWorkflowRequest = { workflowPath };
    return this.request<HarnessSession>(
      `/api/sessions/${encodeURIComponent(sessionId)}/workflow`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
  }

  listTemplates(): Promise<TemplateListResponse> {
    return this.request<TemplateListResponse>("/api/templates");
  }

  getTemplate(id: string): Promise<TemplateDetailView> {
    return this.request<TemplateDetailView>(
      `/api/templates/${encodeURIComponent(id)}`,
    );
  }

  getAccountPlan(): Promise<AccountPlanView> {
    return this.request<AccountPlanView>("/api/account/plan");
  }

  getRunState(executionId: string): Promise<RunView> {
    return this.request<RunView>(
      `/api/runs/${encodeURIComponent(executionId)}/state`,
    );
  }

  async runLocal(
    args: RunLocalArgs,
    onLine: (line: RunLocalLine) => void,
  ): Promise<void> {
    const res = await fetch("/api/runs/local", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": getBootToken(),
      },
      body: JSON.stringify(args),
    });
    // A 4xx here is a bad REQUEST (e.g. missing sourceDir) — the run never
    // started, so there is no NDJSON body to read; surface it like any other
    // API error. A failed *run* is NOT this path: it comes back 200 with a
    // terminal `error`/`summary` line the caller handles in onLine.
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ApiError(
        res.status,
        `POST /api/runs/local → ${res.status}${body ? `: ${body}` : ""}`,
        undefined,
      );
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const drain = (chunk: string, flush: boolean): void => {
      buffer += chunk;
      const { lines, rest } = splitNdjson(buffer, flush);
      buffer = rest;
      for (const raw of lines) {
        const parsed = parseRunLocalLine(raw);
        if (parsed) onLine(parsed);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      drain(decoder.decode(value, { stream: true }), false);
    }
    // Flush the decoder + any trailing line without a newline terminator.
    drain(decoder.decode(), true);
  }

  async deploy(
    workflowPath: string,
    onEvent?: StreamLineHandler<DeployStreamEvent>,
  ): Promise<DeployStreamEvent> {
    // The workflow id in the route path is its absolute path (the server's
    // resolveWorkflow matches on path — see createActionsRouter mount).
    const events = await this.streamNdjson<DeployStreamEvent>(
      `/api/workflows/${encodeURIComponent(workflowPath)}/deploy`,
      { method: "POST" },
      onEvent,
    );
    return terminalDeployEvent(events);
  }

  async run(req: {
    definitionId: string;
    input?: unknown;
  }): Promise<RunResponse> {
    return this.request<RunResponse>("/api/runs", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  /**
   * POST to an NDJSON route and parse the response body line by line, invoking
   * `onLine` for each well-formed JSON line as it arrives and returning every
   * parsed line. Non-JSON lines (stray banner/console noise the server may not
   * have filtered) are skipped — the same "degrade, never throw" stance the
   * server's own stream forwarders take. Throws `ApiError` on a non-2xx status,
   * matching `request()`, so a rejected request (e.g. 409/503) surfaces the
   * same way a normal call would rather than as an empty stream.
   */
  private async streamNdjson<T>(
    path: string,
    init: RequestInit,
    onLine?: StreamLineHandler<T>,
  ): Promise<T[]> {
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": getBootToken(),
        ...init.headers,
      },
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      let reason: string | undefined;
      try {
        const parsed: unknown = body ? JSON.parse(body) : undefined;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { error?: unknown }).error === "string"
        ) {
          reason = (parsed as { error: string }).error;
        }
      } catch {
        // Not JSON — reason stays undefined.
      }
      throw new ApiError(
        res.status,
        `${init.method ?? "GET"} ${path} → ${res.status}${body ? `: ${body}` : ""}`,
        reason,
      );
    }
    const collected: T[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flush = (chunk: string): void => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = parseNdjsonLine<T>(raw);
        if (parsed !== undefined) {
          collected.push(parsed);
          onLine?.(parsed);
        }
        newline = buffer.indexOf("\n");
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
    // A final line with no trailing newline (the server always terminates lines,
    // but be defensive).
    flush(decoder.decode() + "\n");
    return collected;
  }
}

/**
 * Parse one NDJSON line from a generic stream (used by the deploy stream), or
 * `undefined` for a line that carries no value: blank, non-JSON noise, OR a
 * bare `null` (`JSON.parse("null")`). Rejecting `null` here — not just
 * `undefined` — means a stray `null` line is dropped rather than forwarded to
 * the consumer, which would otherwise receive it as an event and could throw
 * downstream. Mirrors {@link parseRunLocalLine}'s null rejection. Pure — no
 * I/O — so it is unit-testable without a live stream.
 */
export function parseNdjsonLine<T>(raw: string): T | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined; // non-JSON noise — skip.
  }
  return parsed === null ? undefined : (parsed as T);
}

/**
 * Split an NDJSON buffer into complete lines plus the unterminated remainder.
 * When `flush` is true the whole buffer is treated as complete (end of stream),
 * so a final line without a trailing newline is not lost. Pure — no I/O — so
 * the incremental parsing is unit-testable without a live stream.
 */
export function splitNdjson(
  buffer: string,
  flush: boolean,
): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  if (flush) {
    return { lines: parts.filter((line) => line.trim() !== ""), rest: "" };
  }
  // The last element is either "" (buffer ended on a newline) or a partial line
  // still being received — keep it in `rest` until its newline arrives.
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim() !== ""), rest };
}

/**
 * Parse one NDJSON line into a {@link RunLocalLine}, or null for a line that
 * isn't a JSON object (stray stdout noise the server may not have filtered).
 * Defensive by design — a run-local child streams another program's stdout, so
 * anything unrecognized degrades to "skip this line", never a throw.
 */
export function parseRunLocalLine(raw: string): RunLocalLine | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // A contract line is a JSON OBJECT — reject null and arrays (a bare array or
  // scalar is noise, not a trace/summary/error line).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  return parsed as RunLocalLine;
}

/** The terminal deploy event (the `ready`/`error` line), or a synthesized
 *  `error` when the stream ended without one — the button always gets a
 *  definite outcome. */
export function terminalDeployEvent(
  events: DeployStreamEvent[],
): DeployStreamEvent {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.phase === "ready" || event.phase === "error") return event;
  }
  return {
    phase: "error",
    code: "NO_OUTPUT",
    message: "deploy produced no terminal status",
  };
}

const delay = (ms = 180): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The demo leasing run's five steps (id, name, authored latency). Shared by the
// terminal completed fixture and the progressive prod-run timeline so both tell
// the same story. Latency is per-step duration only — there is no cost anywhere.
const LEASING_RUN_STEPS: { id: string; name: string; latencyMs: number }[] = [
  { id: "intake", name: "intake", latencyMs: 240 },
  { id: "screen", name: "screen", latencyMs: 610 },
  { id: "credit-check", name: "credit-check", latencyMs: 1900 },
  { id: "approve", name: "approve", latencyMs: 130 },
  { id: "draft-lease", name: "draft-lease", latencyMs: 800 },
];

// Wall-clock so the demo prod run visibly ADVANCES across the 2s poll cadence:
// step i is `running` from i·STEP_MS and `passed` from (i+1)·STEP_MS, so the run
// completes in ~6s no matter how the polls fall. Honest-absence: a `running`
// step carries NO `latencyMs` (it isn't finished); latency appears only once it
// passes; nothing carries cost. Used exclusively for `run()`-minted
// `exec-mock-prod-*` ids, never the terminal default other ids rely on.
export const PROGRESSIVE_STEP_MS = 900;
export function progressiveLeasingRun(
  executionId: string,
  elapsedMs: number,
): RunView {
  const steps: StepView[] = LEASING_RUN_STEPS.map((step, i) => {
    if (elapsedMs >= (i + 1) * PROGRESSIVE_STEP_MS) {
      return {
        id: step.id,
        name: step.name,
        status: "passed",
        latencyMs: step.latencyMs,
      };
    }
    if (elapsedMs >= i * PROGRESSIVE_STEP_MS) {
      return { id: step.id, name: step.name, status: "running" };
    }
    return { id: step.id, name: step.name, status: "pending" };
  });
  const done = steps.every((s) => s.status === "passed");
  return { executionId, status: done ? "completed" : "running", steps };
}

/**
 * Launch edges for mock mode — what `core/canvas-interconnections.ts`'s grep
 * would find across the fixture agents, without a filesystem to grep.
 *
 * Shaped to produce every case the Group axis has to render, against
 * `?mockFixtures=deep` (see MOCK_DEEP_WORKFLOWS):
 *
 *  - `gateway` reaches `queue` and `ads-worker` — a three-member component,
 *    named for the head nothing launches.
 *  - `mailer` reaches `sender` — a second, smaller component, so group ordering
 *    (biggest first) is observable.
 *  - `outreach` reaches `ghost-agent`, which this install does NOT have. An edge
 *    to a missing agent forms NO group, so `outreach` stays in `Ungrouped`.
 *  - `ads` and `rollup` are reached by nothing at all, which is the ordinary
 *    case in a real repo and why `Ungrouped` has to be named rather than hidden.
 *
 * Lives here rather than in `mock-data.ts` because it is a fixture for a route
 * this client owns, and `mock-data.ts` holds no route fixtures.
 */
const MOCK_LAUNCH_EDGES: StudioRailLaunchEdge[] = [
  { parent: "gateway", child: "queue" },
  { parent: "gateway", child: "ads-worker" },
  { parent: "mailer", child: "sender" },
  { parent: "outreach", child: "ghost-agent" },
];

/** One key per project root, mirroring one file per project root. */
const MOCK_RAIL_STATE_PREFIX = "sapiom-mock-studio-rail:";

/**
 * Mock mode's stand-in for the ONE settings field whose whole contract is
 * "survives a reload": `helpSeen` (SAP-2991).
 *
 * The rest of `MockApi`'s settings are per-instance and reset on reload, which
 * is right — a fixture that remembered `telemetryOptIn` or `recentDirs` across
 * page loads would leak one spec's state into the next. But the first-run card
 * is only interesting ACROSS a load, so its flag needs the same treatment
 * `getRailState` already gives the rail file: `localStorage`, because it is the
 * only store in the fixture that outlives the page.
 *
 * The irony is deliberate and harmless. In the mock, the browser origin is
 * stable (Playwright serves one port) and there is no settings file to write;
 * in the real app it is the other way round, which is the entire bug. This key
 * stands in for `~/.sapiom/harness/settings.json`, not for the storage the
 * component stopped using.
 */
const MOCK_HELP_SEEN_KEY = "sapiom-mock-help-seen";

function readMockHelpSeen(): boolean {
  try {
    return window.localStorage.getItem(MOCK_HELP_SEEN_KEY) === "1";
  } catch {
    // Blocked storage: "not seen" shows the card, which is the fixture's
    // default state anyway.
    return false;
  }
}

function writeMockHelpSeen(seen: boolean): void {
  try {
    if (seen) window.localStorage.setItem(MOCK_HELP_SEEN_KEY, "1");
    else window.localStorage.removeItem(MOCK_HELP_SEEN_KEY);
  } catch {
    // Private mode / quota: the in-memory copy still answers this page load.
  }
}

/**
 * `?mockState=fresh` is a BRAND-NEW INSTALL, so the stand-in settings file
 * starts empty. Cleared here, once, rather than by forcing `helpSeen: false`
 * on the read.
 *
 * Two reasons for that shape. There is one settings file and several `MockApi`
 * instances (`mockMoves` below makes the same argument about one disk), so the
 * reset belongs to the page load, not to an instance — and running at module
 * scope puts it before any construction, so it can never land after a dismiss.
 * And clearing beats a forced read, which would silently throw away the write
 * `updateSettings` still makes and break this key's whole contract — that a
 * dismiss survives a reload — for the fixture most likely to want it: dismiss
 * on a fresh install, reload as a returning user, stay dismissed.
 */
if (typeof window !== "undefined" && isFreshMockState())
  writeMockHelpSeen(false);

/**
 * Every rail-state write the mock has served this page load, newest last, for
 * Playwright to read back.
 *
 * MockApi has no other observable effect (same reason `runMacro` records
 * `lastMacroRun`), and the assertion that matters most in this area is a
 * NEGATIVE one: loading the page twice must write nothing at all. A spec that
 * only counted rows would pass while a mount effect quietly stored
 * `groups: []` — which is exactly how the regression shipped.
 */
function recordRailStateWrite(entry: {
  root: string;
  raw: string | null;
}): void {
  if (typeof window === "undefined") return;
  const win = window as unknown as {
    __HARNESS_TEST__?: Record<string, unknown>;
  };
  const previous =
    (win.__HARNESS_TEST__?.railStateWrites as Array<{
      root: string;
      raw: string | null;
    }>) ?? [];
  win.__HARNESS_TEST__ = {
    ...(win.__HARNESS_TEST__ ?? {}),
    railStateWrites: [...previous, entry],
  };
}

/**
 * Mock mode's stand-in for THE DISK, for the one mutation that is a filesystem
 * change: the Project-axis move (SAP-2930).
 *
 * Module-level, not per-instance, and that is the whole reason it exists.
 * `createApi()` is called from several modules (`use-harness-state`,
 * `use-rail-groups`, `use-account-plan`), and each mock instance holds its OWN
 * copy of the fixtures — so a move dispatched through one instance would be
 * invisible to the list the app renders from another. There is only one disk, so
 * there is one log, and every instance's reads fold it in (see the `workflows`
 * and `sessions` accessors below). Reset on reload, like every other mock
 * mutation.
 */
const mockMoves: Array<{ from: string; to: string }> = [];

/** Every move so far, applied in order. Identity-preserving and free when
 *  nothing has moved, which is every spec but this ticket's own. */
function replayMockMoves(p: string): string {
  let at = p;
  for (const move of mockMoves) at = remapUnder(at, move.from, move.to);
  return at;
}

/** Test-only escape hatch, mock mode only: what the rail actually dispatched.
 *  A count-only drag assertion passes when nothing happened at all, so the spec
 *  reads this to prove the drop reached the mover — and that a GROUP-axis drag
 *  never does. */
function recordAgentMove(entry: { from: string; to: string }): void {
  if (typeof window === "undefined") return;
  const win = window as unknown as {
    __HARNESS_TEST__?: Record<string, unknown>;
  };
  const previous =
    (win.__HARNESS_TEST__?.agentMoves as Array<{ from: string; to: string }>) ??
    [];
  win.__HARNESS_TEST__ = {
    ...(win.__HARNESS_TEST__ ?? {}),
    agentMoves: [...previous, entry],
  };
}

/**
 * The ORDER of the two halves of a create, recorded for the spec that asserts
 * it (SAP-2981): the agent is scaffolded, and only then does a session open.
 *
 * An order is the one thing a pair of separate call logs cannot prove — each
 * says it happened, neither says when — and this criterion IS the order:
 * creation completes before the chat starts, so a failure is an error message
 * rather than a confused model. One append-only list, so a spec can read the
 * sequence instead of racing two counters.
 */
function recordCreateStep(kind: "scaffold" | "session", path: string): void {
  if (typeof window === "undefined") return;
  const win = window as unknown as {
    __HARNESS_TEST__?: Record<string, unknown>;
  };
  const previous = (win.__HARNESS_TEST__?.createOrder as string[]) ?? [];
  win.__HARNESS_TEST__ = {
    ...(win.__HARNESS_TEST__ ?? {}),
    createOrder: [...previous, `${kind}:${path}`],
  };
}

/** In-memory, mutable copies of the fixtures — mutations persist for the tab's lifetime, reset on reload. */
/**
 * Mock mode's stand-in for the workflow-keyed board (IA-01).
 *
 * `VITE_MOCK=1` has no harness server, so `GET /api/workflows/:path/graph`
 * cannot answer — and the e2e suite runs entirely in mock mode. This builds the
 * same SHAPE the real route returns for `status: "ok"`: a small three-step graph
 * plus a document that posts `sapiom-canvas:graph` and `sapiom-canvas:size`,
 * which is what the pane's reveal gate actually waits for. It is a fixture, not
 * a renderer — the real route derives from the agent's `sapiom.json` through
 * `deriveWorkflowCanvas` and this cannot.
 *
 * It deliberately does NOT live in `mock-data.ts`: the fixture is keyed by
 * workflow, generated per call, and belongs to this route's mock rather than to
 * the shared seed data.
 */
function mockWorkflowGraph(name: string): CanvasGraph {
  const node = (
    id: string,
    kind: CanvasGraphNode["kind"],
    role: string,
  ): CanvasGraphNode => ({
    id,
    kind,
    label: id,
    role,
    description: "",
    timeoutMs: null,
    inputSchema: null,
    capabilities: [],
  });
  return {
    name,
    entry: "intake",
    nodes: [
      node("intake", "entry", "entry"),
      node("work", "step", "step"),
      node("done", "terminal-success", "terminal · success"),
    ],
    edges: [
      { from: "intake", to: "work", kind: "sequential", label: "" },
      { from: "work", to: "done", kind: "sequential", label: "" },
    ],
    groups: [],
    warnings: [],
  };
}

/**
 * The fixture stand-in for the message documents the real route returns for
 * every status but `ok` — the calm "Preparing your agent" placeholder, the
 * "Nothing rendered yet" page, the honest error panel. They are pages, not
 * boards, and crucially they post NO graph: that is what keeps the pane from
 * revealing itself on setup scaffolding, so the mock must not post one either.
 */
function mockWorkflowMessageDocument(
  title: string,
  subtitle: string | null,
): string {
  const esc = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
    `<title>${esc(title)}</title>`,
    "<style>html,body{height:100%;margin:0;display:grid;place-items:center;",
    'font:13px/1.5 "Geist",system-ui,sans-serif;color:#54545e}',
    "main{text-align:center;max-width:32ch}</style></head><body>",
    `<main data-testid="mock-workflow-message"><h1>${esc(title)}</h1>`,
    subtitle ? `<p>${esc(subtitle)}</p>` : "",
    "</main></body></html>",
  ].join("");
}

/** The fixture board document. Theme comes from the `data-theme` the embedding
 *  pane stamps on the frame's root (a `srcdoc` frame carries no query string,
 *  so the served document's `?theme=` reader has nothing to read). */
function mockWorkflowGraphDocument(name: string, graph: CanvasGraph): string {
  // Escaped even though every value here is fixture-authored: this builds an
  // HTML document by concatenation, and the next person to key it off a real
  // registry name (which is a directory basename) should not have to notice.
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const nodes = graph.nodes
    .map(
      (n) =>
        `<div class="node" data-kind="${esc(n.kind)}" data-step-name="${esc(n.label)}">` +
        `<strong>${esc(n.label)}</strong><small>${esc(n.role)}</small></div>`,
    )
    .join('<div class="edge" aria-hidden="true"></div>');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
    `<title>${esc(name)} — mock agent board</title>`,
    "<style>",
    ":root{--bg:#fff;--ink:#141417;--dim:#54545e;--line:rgba(17,17,20,.12);--node:#f2f2f3}",
    '[data-theme="dark"]{--bg:#12161d;--ink:#f4f4f5;--dim:#a7a7b0;--line:rgba(255,255,255,.14);--node:#17171b}',
    "html,body{height:100%;margin:0;overflow:hidden;background:var(--bg);color:var(--ink);",
    'font:13px/1.5 "Geist",system-ui,sans-serif}',
    ".board{padding:40px 20px 72px;display:flex;flex-direction:column;align-items:center;gap:0}",
    ".node{border:1px solid var(--line);background:var(--node);border-radius:8px;padding:10px 16px;",
    "min-width:180px;text-align:center;display:flex;flex-direction:column;gap:2px}",
    ".node small{color:var(--dim)}",
    ".edge{width:1px;height:24px;background:var(--line)}",
    "</style></head><body>",
    `<main class="board" id="board" data-testid="mock-workflow-board">${nodes}</main>`,
    '<script id="sapiom-graph" type="application/json">',
    JSON.stringify(graph),
    "</script><script>",
    "(function(){",
    'var el=document.getElementById("sapiom-graph");',
    'try{parent.postMessage({type:"sapiom-canvas:graph",graph:JSON.parse(el.textContent||"{}")},"*")}catch(e){}',
    'var b=document.getElementById("board");',
    'try{parent.postMessage({type:"sapiom-canvas:size",width:b.offsetWidth,height:b.offsetHeight,',
    'insetTop:40,insetBottom:72,insetX:20},"*")}catch(e){}',
    "})();",
    "</script></body></html>",
  ].join("");
}

const MOCK_POLSIA_ROOT = "/Users/demo/polsia";

/**
 * A compact Polsia-style direct-call topology for the deep Project fixture.
 * Two source records for Outreach -> Mailer deliberately collapse into one
 * combined connector in the renderer. Rollup stays disconnected so inventory
 * coverage is tested independently of direct invocation extraction.
 */
const MOCK_POLSIA_GRAPH_EDGES: SystemGraph["edges"] = [
  {
    from: "agent:outreach",
    to: "agent:mailer",
    kind: "invokes",
    basis: "static-invocation",
    mode: "blocking",
  },
  {
    from: "agent:outreach",
    to: "agent:mailer",
    kind: "invokes",
    basis: "static-invocation",
    mode: "async",
  },
  {
    from: "agent:ads",
    to: "agent:gateway",
    kind: "invokes",
    basis: "static-invocation",
    mode: "blocking",
  },
  {
    from: "agent:gateway",
    to: "agent:ads-worker",
    kind: "invokes",
    basis: "static-invocation",
    mode: "async",
  },
  {
    from: "agent:gateway",
    to: "agent:queue",
    kind: "invokes",
    basis: "static-invocation",
    mode: "blocking",
  },
  {
    from: "agent:ads-worker",
    to: "agent:queue",
    kind: "invokes",
    basis: "static-invocation",
    mode: "async",
  },
  {
    from: "agent:queue",
    to: "agent:sender",
    kind: "invokes",
    basis: "static-invocation",
    mode: "blocking",
  },
  {
    from: "agent:sender",
    to: "agent:gateway",
    kind: "invokes",
    basis: "static-invocation",
    mode: "async",
  },
];

function codeUnitOrder(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function hasGraphControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function mockCanonicalIdentity(value: string | null): string | null {
  const identity = value?.trim() ?? "";
  return identity !== "" &&
    identity !== "." &&
    identity !== ".." &&
    !identity.startsWith("local:") &&
    !identity.includes("/") &&
    !identity.includes("\\") &&
    !hasGraphControl(identity)
    ? identity
    : null;
}

function mockInventoryPath(scopeRoot: string, workflowPath: string): string {
  if (samePath(scopeRoot, workflowPath)) return ".";
  const normalizedRoot = scopeRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = workflowPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath.slice(normalizedRoot.length + 1);
}

export interface MockSystemGraphProjection {
  nodes: SystemGraph["nodes"];
  targets: SystemGraphNavigationResponse["targets"];
  warnings: SystemGraph["warnings"];
  degraded: boolean;
}

/** Process-local discovery proof used by the browser mock. The real REST
 * WorkflowInfo intentionally does not expose registry evidence, so mock graph
 * projection receives the same information as a separate sidecar. */
export interface MockWorkflowIdentityEvidence {
  kind: "marker" | "source" | "not-agent" | "unknown";
  sourceDefinitionName?: string | null;
}

export type MockWorkflowIdentityEvidenceByPath = Readonly<
  Record<string, MockWorkflowIdentityEvidence>
>;

/** Deterministic identity/navigation projection for the browser mock. */
export function projectMockSystemGraphInventory(
  scopeRoot: string,
  workflows: readonly WorkflowInfo[],
  evidenceByPath: MockWorkflowIdentityEvidenceByPath = {},
): MockSystemGraphProjection {
  const rows = workflows
    .filter((workflow) => isWithinDir(scopeRoot, workflow.path))
    .map((workflow) => {
      const inventoryPath = mockInventoryPath(scopeRoot, workflow.path);
      const fallbackKey = `local:${inventoryPath === "." ? "root" : inventoryPath}`;
      const marker = mockCanonicalIdentity(workflow.definitionSlug);
      const evidence = evidenceByPath[workflow.path];
      const hasPersistedSourceName =
        evidence !== undefined &&
        Object.prototype.hasOwnProperty.call(evidence, "sourceDefinitionName");
      const sourceName = hasPersistedSourceName
        ? mockCanonicalIdentity(evidence.sourceDefinitionName ?? null)
        : null;
      const sourceIsAuthoritative =
        evidence?.kind === "source" ||
        (evidence?.kind === "unknown" && hasPersistedSourceName);
      // `unknown` may retain the last accepted syntax identity for continuity,
      // but it can never make the graph ready until a fresh scan proves it.
      const degraded =
        evidence?.kind === "unknown" ||
        (evidence?.kind === "source" && sourceName === null);
      const canonical = sourceIsAuthoritative
        ? sourceName !== null
        : evidence?.kind === "not-agent"
          ? false
          : marker !== null;
      return {
        workflow,
        inventoryPath,
        fallbackKey,
        candidateKey: sourceIsAuthoritative
          ? (sourceName ?? fallbackKey)
          : (marker ?? fallbackKey),
        canonical,
        degraded,
      };
    })
    .sort(
      (left, right) =>
        codeUnitOrder(left.inventoryPath, right.inventoryPath) ||
        codeUnitOrder(left.candidateKey, right.candidateKey) ||
        codeUnitOrder(left.workflow.name, right.workflow.name) ||
        codeUnitOrder(left.workflow.path, right.workflow.path),
    )
    .filter(
      (row, index, all) =>
        all.findIndex((candidate) =>
          samePath(candidate.workflow.path, row.workflow.path),
        ) === index,
    );
  const canonicalCounts = new Map<string, number>();
  const provisionalCounts = new Map<string, number>();
  for (const row of rows) {
    const counts = row.canonical ? canonicalCounts : provisionalCounts;
    counts.set(row.candidateKey, (counts.get(row.candidateKey) ?? 0) + 1);
  }
  const used = new Set<string>();
  const projected = rows.map((row) => {
    const canonicalCount = canonicalCounts.get(row.candidateKey) ?? 0;
    const provisionalCount = provisionalCounts.get(row.candidateKey) ?? 0;
    const ambiguous = row.canonical
      ? canonicalCount > 1
      : canonicalCount === 0 && provisionalCount > 1;
    const shadowedByCanonical = !row.canonical && canonicalCount > 0;
    const base =
      ambiguous || shadowedByCanonical ? row.fallbackKey : row.candidateKey;
    let agentKey = base;
    let suffix = 2;
    while (used.has(agentKey)) {
      agentKey = `${base}~${suffix}`;
      suffix += 1;
    }
    used.add(agentKey);
    return {
      agentKey,
      label: row.workflow.name,
      workflowPath: row.workflow.path,
    };
  });
  projected.sort((left, right) => codeUnitOrder(left.agentKey, right.agentKey));
  const duplicateCandidates = [
    ...new Set([...canonicalCounts.keys(), ...provisionalCounts.keys()]),
  ]
    .filter((candidateKey) => {
      const canonicalCount = canonicalCounts.get(candidateKey) ?? 0;
      const provisionalCount = provisionalCounts.get(candidateKey) ?? 0;
      return (
        (canonicalCount > 1 ||
          (canonicalCount === 0 && provisionalCount > 1)) &&
        mockCanonicalIdentity(candidateKey) !== null
      );
    })
    .sort(codeUnitOrder);
  return {
    nodes: projected.map(({ agentKey, label }) => ({
      id: `agent:${agentKey}`,
      agentKey,
      label,
    })),
    targets: projected.map(({ agentKey, workflowPath }) => ({
      agentKey,
      workflowPath,
    })),
    warnings: duplicateCandidates.map((candidateKey) => ({
      code: "duplicate-agent-key",
      agentKey: candidateKey,
      message: `Multiple agents use ${candidateKey}; kept each with a local identity.`,
    })),
    degraded:
      duplicateCandidates.length > 0 || rows.some((row) => row.degraded),
  };
}

export class MockApi implements HarnessApi {
  // Mock auth state: flipped by startAuth() / disconnect() so D7 e2e tests
  // can drive the full sign-in flow deterministically without a real browser.
  private _authenticated = false;
  private _organizationName: string | null = null;
  // First-poll wall-clock per progressive prod run, so the timeline is measured
  // from when the run was first observed (not module load) — see getRunState.
  private progressiveRunStart = new Map<string, number>();
  /** Stable for the lifetime of the mock process, mirroring server-issued
   * opaque keys without putting filesystem paths into graph payloads. */
  private workspaceKeys = new Map<string, WorkspaceKey>();
  private studioProjectIds = new Map<string, StudioProjectId>();
  private studioPreferences = new Map<
    StudioProjectId,
    StudioWorkspaceSelection
  >();
  private systemGraphSnapshots = new Map<WorkspaceKey, SystemGraphSnapshot>();
  private systemGraphNavigation = new Map<
    WorkspaceKey,
    SystemGraphNavigationResponse
  >();
  private systemGraphRevision = new Map<WorkspaceKey, number>();
  private pendingSystemGraphRevision = new Map<WorkspaceKey, number>();

  async startAuth(): Promise<AuthStartResponse> {
    // Record the call for Playwright assertions (same pattern as runMacro/deploy).
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
      };
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        lastAuthStart: Date.now(),
      };
    }
    // Simulate a brief browser round-trip then flip to authenticated.
    // The real server is async (returns immediately, resolves via bus), but
    // the mock resolves the whole flow inline so tests can `await startAuth()`
    // and immediately see the new state via `authStatus()` — no polling needed.
    await delay(300);
    this._authenticated = true;
    this._organizationName = "Mock Workspace";
    // Publish an auth.changed bus message so any open subscriptions update.
    void import("./events").then(({ publishMockBusMessage }) => {
      publishMockBusMessage({
        type: "auth.changed",
        authenticated: true,
        organizationName: "Mock Workspace",
      });
    });
    return { started: true };
  }

  async disconnect(): Promise<{ ok: true }> {
    await delay(200);
    this._authenticated = false;
    this._organizationName = null;
    void import("./events").then(({ publishMockBusMessage }) => {
      publishMockBusMessage({
        type: "auth.changed",
        authenticated: false,
        organizationName: null,
      });
    });
    return { ok: true };
  }

  async authStatus(): Promise<AuthStatusResponse> {
    await delay(120);
    return {
      authenticated: this._authenticated,
      organizationName: this._organizationName,
    };
  }

  // `?mockState=fresh` = brand-new install: nothing yet, firstRun set — see isFreshMockState().
  private readonly fresh = isFreshMockState();
  // `?mockConsentSource=prompted` mirrors a user who answered yes at the TTY prompt:
  // telemetryOptIn starts true so the chip shows "analytics on" from the first render.
  private readonly promptedConsent =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("mockConsentSource") ===
      "prompted";
  // Playwright-only fixture shape: retain the persisted workspace/agent
  // inventory while removing every session, so the folder graph's
  // no-active-session contract is exercised without fabricating UI state.
  private readonly noLiveSessions =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("mockNoLiveSessions") ===
      "1";
  private sessionsStore: HarnessSession[] =
    this.fresh || this.noLiveSessions
      ? []
      : MOCK_SESSIONS.map((session) => ({ ...session }));
  /** Live planner records are mutable mock state, unlike the fixed history
   * fixtures. They exercise the same record-refetch path as the real server. */
  private plannerSessionRecords = new Map<string, SessionRecord>();
  private workflowsStore: WorkflowInfo[] = this.fresh
    ? []
    : [
        ...MOCK_WORKFLOWS,
        ...(isSearchFixturesEnabled() ? MOCK_SEARCH_WORKFLOWS : []),
      ].map((workflow) => ({ ...workflow }));
  /** Mock-only equivalent of the server's private accepted identity sidecar. */
  private workflowIdentityEvidenceStore: Record<
    string,
    MockWorkflowIdentityEvidence
  > = Object.fromEntries(
    this.workflowsStore
      .filter(
        (workflow) =>
          workflow.path === `${MOCK_POLSIA_ROOT}/backend/src/agents/outreach`,
      )
      .map((workflow) => [
        workflow.path,
        { kind: "source", sourceDefinitionName: "outreach" } as const,
      ]),
  );

  /*
   * Every read of the fixtures goes through the move log (`mockMoves`), so a
   * moved agent reads at its NEW path from every instance and every call site —
   * rather than only from the one method that happened to remember. With no
   * move recorded these return the backing array untouched, so nothing else in
   * the mock changes shape.
   */
  private get workflows(): WorkflowInfo[] {
    if (mockMoves.length === 0) return this.workflowsStore;
    return this.workflowsStore.map((workflow) => ({
      ...workflow,
      path: replayMockMoves(workflow.path),
    }));
  }

  private set workflows(next: WorkflowInfo[]) {
    this.workflowsStore = next;
    this.invalidateSystemGraphProjections();
  }

  private get workflowIdentityEvidence(): MockWorkflowIdentityEvidenceByPath {
    if (mockMoves.length === 0) return this.workflowIdentityEvidenceStore;
    return Object.fromEntries(
      Object.entries(this.workflowIdentityEvidenceStore).map(
        ([workflowPath, evidence]) => [replayMockMoves(workflowPath), evidence],
      ),
    );
  }

  /**
   * Mock/test mutation seam for the syntax-discovery lifecycle. It keeps the
   * private proof sidecar out of WorkflowInfo while exercising the same rail
   * event plus revisioned graph invalidation as production add/edit/delete.
   */
  replaceSourceDiscoveredWorkflows(
    workflows: readonly WorkflowInfo[],
    evidenceByPath: MockWorkflowIdentityEvidenceByPath,
  ): void {
    this.workflowIdentityEvidenceStore = { ...evidenceByPath };
    this.workflows = workflows.map((workflow) => ({ ...workflow }));
    void import("./events").then(({ publishMockBusMessage }) => {
      publishMockBusMessage({ type: "workflows.changed" });
    });
  }

  private allocateSystemGraphRevision(workspaceKey: WorkspaceKey): number {
    const revision = (this.systemGraphRevision.get(workspaceKey) ?? 0) + 1;
    this.systemGraphRevision.set(workspaceKey, revision);
    return revision;
  }

  private invalidateSystemGraphProjections(): void {
    for (const [workspaceKey, snapshot] of this.systemGraphSnapshots) {
      const revision = this.allocateSystemGraphRevision(workspaceKey);
      this.pendingSystemGraphRevision.set(workspaceKey, revision);
      this.systemGraphSnapshots.delete(workspaceKey);
      this.systemGraphNavigation.delete(workspaceKey);
      void import("./events").then(({ publishMockBusMessage }) => {
        publishMockBusMessage({
          type: "system-graph.changed",
          workspaceKey,
          revision,
          state: snapshot.graph ? "stale" : "building",
        });
      });
    }
  }

  /** A session whose cwd sat inside a moved directory follows it — on disk it
   *  has no choice, and a session pointing at a directory that no longer exists
   *  is the bug this remap prevents. Its binding travels the same way. */
  private get sessions(): HarnessSession[] {
    if (mockMoves.length === 0) return this.sessionsStore;
    return this.sessionsStore.map((session) => ({
      ...session,
      cwd: replayMockMoves(session.cwd),
      boundWorkflowPath:
        session.boundWorkflowPath == null
          ? session.boundWorkflowPath
          : replayMockMoves(session.boundWorkflowPath),
    }));
  }

  private set sessions(next: HarnessSession[]) {
    this.sessionsStore = next;
  }
  private settings: HarnessSettings = {
    ...(this.fresh
      ? { ...MOCK_SETTINGS, recentDirs: [] }
      : {
          ...MOCK_SETTINGS,
          recentDirs: [...MOCK_SETTINGS.recentDirs],
          ...(this.promptedConsent ? { telemetryOptIn: true } : {}),
        }),
    // Seeded from the reload-surviving store rather than from the fixture —
    // see MOCK_HELP_SEEN_KEY, which the `fresh` fixture has already emptied by
    // the time any instance is built.
    helpSeen: readMockHelpSeen(),
  };

  private workspaceKey(cwd: string): WorkspaceKey {
    const existing = this.workspaceKeys.get(cwd);
    if (existing) return existing;
    const key = `workspace-mock-${this.workspaceKeys.size + 1}`;
    this.workspaceKeys.set(cwd, key);
    return key;
  }

  private studioProjectId(cwd: string): StudioProjectId {
    const existing = this.studioProjectIds.get(cwd);
    if (existing) return existing;
    // Valid UUID-shaped IDs keep mock and real strict parsing identical.
    const ordinal = String(this.studioProjectIds.size + 1).padStart(12, "0");
    const projectId = `project_00000000-0000-4000-8000-${ordinal}`;
    this.studioProjectIds.set(cwd, projectId);
    return projectId;
  }

  private workspaceScopes(): WorkspaceScopeSummary[] {
    const roots = new Set([
      ...this.settings.recentDirs,
      ...this.sessions.map((session) => session.cwd),
    ]);
    return [...roots]
      .sort((left, right) => left.localeCompare(right))
      .map((cwd) => ({
        cwd,
        workspaceKey: this.workspaceKey(cwd),
        projectId: this.studioProjectId(cwd),
      }));
  }

  private studioProjects(): StudioProjectSummary[] {
    // Production authority is determined by the server response and always
    // uses durable Studio project summaries. Mock mode keeps the historical
    // fixtures stable unless a plan-first scenario opts in explicitly; the
    // dedicated agent-map fixture is also an opt-in. This is test data
    // selection, not a product feature flag.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const mode = params.get("mockStudioProjects");
      const fixture = params.get("mockFixtures");
      if (mode !== "present" && fixture !== "agent-map") return [];
    }
    const timestamp = "2026-01-01T00:00:00.000Z";
    return this.workspaceScopes().map((scope, index) => ({
      projectId: scope.projectId!,
      identityVersion: 1,
      displayName: basenameOf(scope.cwd) || "Project",
      bindings: [
        {
          id: `root_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          status: "active",
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  private studioWorkflows(): WorkflowInfo[] {
    const scopes = this.workspaceScopes();
    return this.workflows.map((workflow, index) => {
      const bindings = scopes
        .filter(
          (candidate) =>
            candidate.projectId && isWithinDir(candidate.cwd, workflow.path),
        )
        .map((scope, bindingIndex) => ({
          projectId: scope.projectId!,
          agentId: `agent_00000000-0000-4000-${String(bindingIndex).padStart(4, "0")}-${String(index + 1).padStart(12, "0")}`,
        }));
      return bindings.length > 0
        ? {
            ...workflow,
            studioBindings: bindings,
          }
        : workflow;
    });
  }

  async getState(): Promise<AppState> {
    await delay();
    // Test-only 401 simulation: `?mockBoot401=1` in the URL makes the boot
    // fetch fail with a rejected credential (status 401) on the second
    // getState() call only — the real boot fetch under React 18 StrictMode's
    // double-effect invocation. The first (StrictMode's discarded run) and
    // third+ (Retry) calls succeed normally. This lets the e2e suite assert
    // that a 401 boot never produces a lockout: the ConnectivityScreen appears,
    // Retry recovers, and the full shell renders. The counter is monotonic and
    // is never cleared.
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __MOCK_BOOT_401_CALL_COUNT__?: number;
      };
      const boot401 =
        new URLSearchParams(window.location.search).get("mockBoot401") === "1";
      if (boot401) {
        // NOTE: relies on React 18 StrictMode's double-invoke of the boot effect;
        // valid only in VITE_MOCK=1 + the Vite dev server.
        // Strategy: count calls. Fail on call #2 (the real boot fetch). Calls
        // #1 (StrictMode's discarded run) and #3+ (Retry) succeed normally.
        // This lets the e2e assert: 401 → ConnectivityScreen → Retry → shell.
        const prev = win.__MOCK_BOOT_401_CALL_COUNT__ ?? 0;
        win.__MOCK_BOOT_401_CALL_COUNT__ = prev + 1;
        if (prev + 1 === 2) {
          throw new ApiError(
            401,
            "GET /api/state → 401: credential rejected (mock)",
            "credential rejected",
          );
        }
      }
    }
    // mockConsentSource query param lets Playwright exercise all chip states:
    //   ?mockConsentSource=env-forced-off  → "analytics off (env)" chip
    //   ?mockConsentSource=default-silent  → shows TelemetryNotice
    //   ?mockConsentSource=stored-explicit → off chip (telemetryOptIn=false)
    //   ?mockConsentSource=prompted        → on chip (telemetryOptIn=true in mock)
    const mockConsentSource =
      typeof window !== "undefined"
        ? ((new URLSearchParams(window.location.search).get(
            "mockConsentSource",
          ) as AppState["consentSource"]) ?? "stored-explicit")
        : "stored-explicit";
    const mockEnvReason =
      typeof window !== "undefined"
        ? (new URLSearchParams(window.location.search).get("mockEnvReason") ??
          null)
        : null;
    // When consent was answered via a TTY prompt ("prompted"), the user
    // necessarily said yes — mirror that in the mock so the chip shows "on".
    const telemetryOptIn =
      mockConsentSource === "prompted" ? true : this.settings.telemetryOptIn;
    return {
      version: "0.0.1-mock",
      authenticated: true,
      userId: "user_mock",
      tenantId: "tenant_mock",
      organizationName: "Acme (mock)",
      telemetryOptIn,
      // Light product analytics defaults on; e2e can force off with
      // ?mockProductAnalytics=off to assert the PostHog opt-out gate.
      productAnalyticsOptIn:
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get(
          "mockProductAnalytics",
        ) === "off"
          ? false
          : true,
      sessions: this.sessions,
      workflows: this.studioWorkflows(),
      workspaceScopes: this.workspaceScopes(),
      studioProjects: this.studioProjects(),
      macros: MOCK_MACROS,
      launchDir: MOCK_LAUNCH_DIR,
      // Mirrors the Electron host (`<launchDir>/projects`) rather than the CLI
      // host (bare launchDir), so mock mode exercises the more interesting of
      // the two: a project root that differs from the launch dir.
      defaultProjectRoot: `${MOCK_LAUNCH_DIR}/projects`,
      consentSource: mockConsentSource,
      ...(mockEnvReason ? { consentEnvReason: mockEnvReason } : {}),
      ...(this.fresh ? { firstRun: true } : {}),
    };
  }

  async getAgentMapWorkspace(
    projectId: StudioProjectId,
  ): Promise<AgentMapWorkspaceResponse> {
    await delay();
    const failure =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get(
            "mockAgentMapWorkspace",
          );
    if (failure === "error") {
      throw new ApiError(
        503,
        "Agent Map storage is unavailable",
        "Agent Map storage is unavailable",
      );
    }
    if (failure === "unauthorized") {
      throw new ApiError(
        403,
        "Studio project is not available",
        "Studio project is not available",
      );
    }
    const project = this.studioProjects().find(
      (candidate) => candidate.projectId === projectId,
    );
    if (!project) {
      throw new ApiError(
        404,
        "Studio project not found",
        "Studio project not found",
      );
    }
    return parseAgentMapWorkspaceResponse(
      {
        project,
        workspace: {
          projectId,
          schemaVersion: 1,
          recordVersion: 1,
          confirmedRevisionId: null,
          activeProposalId: null,
          projectBuildPlanId: null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      },
      projectId,
    );
  }

  async getStudioCurrentWorkspace(
    projectId: StudioProjectId,
  ): Promise<StudioCurrentWorkspaceResponse> {
    await delay();
    const agents = this.studioWorkflows().flatMap((workflow) => {
      const binding = workflow.studioBindings?.find(
        (candidate) => candidate.projectId === projectId,
      );
      return binding
        ? [
            {
              agentId: binding.agentId,
              name: workflow.name,
              definitionId: workflow.definitionId,
            },
          ]
        : [];
    });
    const requested = this.studioPreferences.get(projectId);
    const valid =
      requested?.kind !== "agent" ||
      agents.some((agent) => agent.agentId === requested.agentId);
    const repaired = Boolean(requested && !valid);
    const selection =
      requested && valid
        ? requested
        : { kind: "agent-map" as const, projectId };
    if (repaired) this.studioPreferences.set(projectId, selection);
    return parseStudioCurrentWorkspaceResponse(
      { projectId, selection, agents, repaired },
      projectId,
    );
  }

  async putStudioCurrentWorkspace(
    projectId: StudioProjectId,
    requested: StudioWorkspaceSelection,
  ): Promise<StudioCurrentWorkspaceResponse> {
    const current = await this.getStudioCurrentWorkspace(projectId);
    const valid =
      requested.projectId === projectId &&
      (requested.kind === "agent-map" ||
        current.agents.some((agent) => agent.agentId === requested.agentId));
    const selection = valid
      ? requested
      : { kind: "agent-map" as const, projectId };
    this.studioPreferences.set(projectId, selection);
    return { ...current, selection, repaired: !valid };
  }

  async openPlannerSession(
    projectId: StudioProjectId,
    request: PlannerSessionRequest,
  ): Promise<PlannerSessionResponse> {
    const failure =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("mockPlanner");
    if (failure === "error") {
      throw new ApiError(
        503,
        "Planner service is unavailable",
        "Planner service is unavailable",
      );
    }
    if (failure === "unauthorized") {
      throw new ApiError(
        403,
        "Planner project is not available",
        "Planner project is not available",
      );
    }
    const existing = this.sessions
      .filter(
        (session) =>
          session.status !== "exited" &&
          session.planning?.identity.projectId === projectId &&
          session.planning.identity.userId === "user_mock",
      )
      .sort((left, right) =>
        right.lastActiveAt.localeCompare(left.lastActiveAt),
      )[0];
    if (request.mode === "resume-or-create" && existing) {
      return { session: existing, resolution: "live" };
    }
    const root = [...this.studioProjectIds.entries()].find(
      ([, id]) => id === projectId,
    )?.[0];
    if (!root) {
      throw new ApiError(
        404,
        "Studio project not found",
        "Studio project not found",
      );
    }
    const session = await this.createSession({
      cwd: root,
      harness: request.harness ?? "claude-code",
      ...(request.theme ? { theme: request.theme } : {}),
    });
    const greetingFixture =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("mockGreeting");
    session.planning = {
      identity: {
        projectId,
        sessionId: session.id,
        userId: "user_mock",
        role: "map-planner",
      },
      greeting:
        greetingFixture === "generating"
          ? { status: "generating", attemptId: "attempt_mock" }
          : greetingFixture === "failed"
            ? {
                status: "failed",
                retryable: true,
                errorCode: "model_turn_failed",
              }
            : {
                status: "delivered",
                messageId: "message_mock_greeting",
              },
      queuedInputIds: [],
    };
    const now = new Date().toISOString();
    this.plannerSessionRecords.set(session.id, {
      harnessSessionId: session.id,
      mergedSessionIds: [session.id],
      agentSessionId: session.agentSessionId,
      harness: session.harness,
      cwd: session.cwd,
      startedAt: now,
      endedAt: null,
      turns:
        session.planning.greeting.status === "delivered"
          ? [
              {
                index: 1,
                prompt: null,
                promptAt: null,
                toolCalls: [],
                assistantText:
                  "I’m your project planning agent. We’ll plan the agents, responsibilities, data flow, resources, and connectors together. What kind of agent architecture do you want to build?",
                model: "mock-planner",
                usage: null,
                completedAt: now,
                incomplete: false,
              },
            ]
          : [],
      turnCount: 0,
      eventCount: session.planning.greeting.status === "delivered" ? 2 : 0,
      reconstructed: true,
      archivedAt: null,
      limitations: [],
    });
    return { session, resolution: "created" };
  }

  async sendPlannerMessage(
    projectId: StudioProjectId,
    sessionId: string,
    request: PlannerMessageRequest,
  ): Promise<PlannerSessionMetadataResponse> {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (session?.planning?.identity.projectId !== projectId) {
      throw new ApiError(
        403,
        "Forbidden planner session",
        "Forbidden planner session",
      );
    }
    const inputId = `input_mock_${Date.now()}`;
    session.planning = {
      ...session.planning,
      greeting:
        session.planning.greeting.status === "delivered" ||
        session.planning.greeting.status === "skipped"
          ? session.planning.greeting
          : { status: "skipped", reason: "user-proceeded" },
      queuedInputIds: [...session.planning.queuedInputIds, inputId],
    };
    await this.injectInput(sessionId, { text: request.text });
    const accepted = structuredClone(session.planning);
    setTimeout(() => {
      const current = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      const record = this.plannerSessionRecords.get(sessionId);
      if (!current?.planning || !record) return;
      const completedAt = new Date().toISOString();
      const turns = [
        ...record.turns,
        {
          index: record.turns.length + 1,
          prompt: request.text,
          promptAt: completedAt,
          toolCalls: [],
          assistantText:
            "Let’s start by clarifying the outcome, the actors involved, and the information they need to exchange.",
          model: "mock-planner",
          usage: null,
          completedAt,
          incomplete: false,
        },
      ];
      this.plannerSessionRecords.set(sessionId, {
        ...record,
        turns,
        turnCount: record.turnCount + 1,
        eventCount: record.eventCount + 2,
      });
      current.planning = {
        ...current.planning,
        queuedInputIds: current.planning.queuedInputIds.filter(
          (candidate) => candidate !== inputId,
        ),
      };
      void import("./events").then(({ publishMockBusMessage }) => {
        publishMockBusMessage({ type: "session.status", session: current });
        publishMockBusMessage({
          type: "session.record.changed",
          harnessSessionId: sessionId,
        });
      });
    }, 250);
    return { metadata: accepted };
  }

  async retryPlannerGreeting(
    projectId: StudioProjectId,
    sessionId: string,
  ): Promise<PlannerSessionMetadataResponse> {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (session?.planning?.identity.projectId !== projectId) {
      throw new ApiError(
        403,
        "Forbidden planner session",
        "Forbidden planner session",
      );
    }
    const retryFailure =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get(
            "mockGreetingRetry",
          );
    if (retryFailure === "error") {
      throw new ApiError(
        503,
        "Greeting retry is temporarily unavailable",
        "Greeting retry is temporarily unavailable",
      );
    }
    if (
      session.planning.greeting.status !== "failed" ||
      !session.planning.greeting.retryable ||
      session.planning.queuedInputIds.length > 0
    ) {
      throw new ApiError(
        409,
        "Greeting retry is not available",
        "Greeting retry is not available",
      );
    }
    session.planning = {
      ...session.planning,
      greeting: { status: "generating", attemptId: "attempt_mock_retry" },
    };
    const retrying = structuredClone(session.planning);
    setTimeout(() => {
      const current = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      const record = this.plannerSessionRecords.get(sessionId);
      if (!current?.planning || !record) return;
      const completedAt = new Date().toISOString();
      current.planning = {
        ...current.planning,
        greeting: {
          status: "delivered",
          messageId: "message_mock_greeting_retry",
        },
      };
      this.plannerSessionRecords.set(sessionId, {
        ...record,
        turns: [
          ...record.turns,
          {
            index: record.turns.length + 1,
            prompt: null,
            promptAt: null,
            toolCalls: [],
            assistantText:
              "I’m your project planning agent. What kind of agent architecture do you want to build?",
            model: "mock-planner",
            usage: null,
            completedAt,
            incomplete: false,
          },
        ],
        eventCount: record.eventCount + 2,
      });
      void import("./events").then(({ publishMockBusMessage }) => {
        publishMockBusMessage({ type: "session.status", session: current });
        publishMockBusMessage({
          type: "session.record.changed",
          harnessSessionId: sessionId,
        });
      });
    }, 250);
    return { metadata: retrying };
  }

  async getSystemGraph(
    workspaceKey: WorkspaceKey,
    options: { refresh?: boolean } = {},
  ): Promise<SystemGraphSnapshot> {
    const graphControl =
      typeof window === "undefined"
        ? null
        : (window as unknown as {
            __HARNESS_TEST__?: Record<string, unknown>;
            __MOCK_SYSTEM_GRAPH_FAIL_ONCE__?: boolean;
            __MOCK_SYSTEM_GRAPH_DEGRADED_REMAINING__?: number;
            __MOCK_SYSTEM_GRAPH_STATE__?: SystemGraphSnapshot["state"];
            __MOCK_SYSTEM_GRAPH_REVISION__?: number;
          });
    const cached = this.systemGraphSnapshots.get(workspaceKey);
    const fixtureRequestsProjection =
      cached !== undefined &&
      graphControl !== null &&
      (graphControl.__MOCK_SYSTEM_GRAPH_FAIL_ONCE__ === true ||
        (graphControl.__MOCK_SYSTEM_GRAPH_DEGRADED_REMAINING__ ?? 0) > 0 ||
        (graphControl.__MOCK_SYSTEM_GRAPH_STATE__ !== undefined &&
          graphControl.__MOCK_SYSTEM_GRAPH_STATE__ !== cached.state) ||
        (graphControl.__MOCK_SYSTEM_GRAPH_REVISION__ !== undefined &&
          graphControl.__MOCK_SYSTEM_GRAPH_REVISION__ !== cached.revision));
    if (
      !options.refresh &&
      cached &&
      !this.pendingSystemGraphRevision.has(workspaceKey) &&
      !fixtureRequestsProjection
    ) {
      return cached;
    }
    const graphDelay =
      typeof window === "undefined"
        ? 180
        : ((window as unknown as { __MOCK_SYSTEM_GRAPH_DELAY_MS__?: number })
            .__MOCK_SYSTEM_GRAPH_DELAY_MS__ ?? 180);
    await delay(graphDelay);
    const selectedScope = this.workspaceScopes().find(
      (scope) => scope.workspaceKey === workspaceKey,
    );
    if (!selectedScope) {
      throw new ApiError(404, "Workspace not found", "Workspace not found");
    }
    let state: SystemGraphSnapshot["state"] = "ready";
    let revision =
      this.pendingSystemGraphRevision.get(workspaceKey) ??
      this.allocateSystemGraphRevision(workspaceKey);
    this.pendingSystemGraphRevision.delete(workspaceKey);
    if (graphControl) {
      const win = graphControl;
      const previous =
        (win.__HARNESS_TEST__?.systemGraphRequests as
          | WorkspaceKey[]
          | undefined) ?? [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        systemGraphRequests: [...previous, workspaceKey],
      };
      if (win.__MOCK_SYSTEM_GRAPH_FAIL_ONCE__) {
        win.__MOCK_SYSTEM_GRAPH_FAIL_ONCE__ = false;
        throw new ApiError(
          500,
          "System graph projection failed",
          "System graph projection failed",
        );
      }
      const degradedRemaining =
        win.__MOCK_SYSTEM_GRAPH_DEGRADED_REMAINING__ ?? 0;
      if (degradedRemaining > 0) {
        state = "degraded";
        win.__MOCK_SYSTEM_GRAPH_DEGRADED_REMAINING__ = degradedRemaining - 1;
      }
      state = win.__MOCK_SYSTEM_GRAPH_STATE__ ?? state;
      revision = win.__MOCK_SYSTEM_GRAPH_REVISION__ ?? revision;
      this.systemGraphRevision.set(
        workspaceKey,
        Math.max(this.systemGraphRevision.get(workspaceKey) ?? 0, revision),
      );
    }
    const fixtureGraph: SystemGraph = {
      kind: "system",
      scope: { kind: "working-tree", workspaceKey },
      nodes: [
        { id: "agent:growth", agentKey: "growth", label: "Growth" },
        { id: "agent:leasing", agentKey: "leasing", label: "Leasing" },
        {
          id: "agent:reporting",
          agentKey: "reporting",
          label: "Reporting",
        },
        {
          id: "agent:research",
          agentKey: "research",
          label: "Research",
        },
        {
          id: "agent:standalone",
          agentKey: "standalone",
          label: "Standalone",
        },
      ],
      edges: [
        {
          from: "agent:research",
          to: "agent:growth",
          kind: "invokes",
          basis: "static-invocation",
          mode: "blocking",
        },
        {
          from: "agent:research",
          to: "agent:growth",
          kind: "invokes",
          basis: "static-invocation",
          mode: "async",
        },
        {
          from: "agent:research",
          to: "agent:leasing",
          kind: "invokes",
          basis: "static-invocation",
          mode: "async",
        },
        {
          from: "agent:growth",
          to: "agent:research",
          kind: "invokes",
          basis: "static-invocation",
          mode: "async",
        },
        {
          from: "agent:reporting",
          to: "agent:leasing",
          kind: "invokes",
          basis: "static-invocation",
          mode: "blocking",
        },
      ],
      warnings: [],
    };
    // Keep the original invocation-rich graph for acme-app's graph behavior
    // specs. Every other mock project is an honest inventory projection of the
    // agents beneath that exact root, which lets Project-axis tests prove parent
    // and nested projects expose the same membership as the rail.
    const projection = projectMockSystemGraphInventory(
      selectedScope.cwd,
      this.workflows,
      this.workflowIdentityEvidence,
    );
    const graph = samePath(selectedScope.cwd, "/Users/demo/acme-app")
      ? fixtureGraph
      : {
          kind: "system" as const,
          scope: { kind: "working-tree" as const, workspaceKey },
          nodes: projection.nodes,
          edges: samePath(selectedScope.cwd, MOCK_POLSIA_ROOT)
            ? MOCK_POLSIA_GRAPH_EDGES
            : [],
          warnings: projection.warnings,
        };
    if (
      !samePath(selectedScope.cwd, "/Users/demo/acme-app") &&
      state === "ready" &&
      projection.degraded
    ) {
      state = "degraded";
    }
    const snapshot = { workspaceKey, revision, state, graph };
    const graphKeys = new Set(graph.nodes.map((node) => node.agentKey));
    const navigation = {
      workspaceKey,
      revision,
      targets: projection.targets.filter((target) =>
        graphKeys.has(target.agentKey),
      ),
    };
    this.systemGraphSnapshots.set(workspaceKey, snapshot);
    this.systemGraphNavigation.set(workspaceKey, navigation);
    return snapshot;
  }

  async getSystemGraphNavigation(
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphNavigationResponse> {
    const snapshot =
      this.systemGraphSnapshots.get(workspaceKey) ??
      (await this.getSystemGraph(workspaceKey));
    return (
      this.systemGraphNavigation.get(workspaceKey) ?? {
        workspaceKey,
        revision: snapshot.revision,
        targets: [],
      }
    );
  }

  async createSession(req: CreateSessionRequest): Promise<HarnessSession> {
    await delay(300);
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
        __MOCK_CREATE_SESSION_FAIL_ONCE__?: boolean;
      };
      const previous =
        (win.__HARNESS_TEST__?.createSessionCalls as unknown[] | undefined) ??
        [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        lastCreateSession: { req },
        createSessionCalls: [...previous, { req }],
      };
      recordCreateStep("session", req.cwd);
      if (win.__MOCK_CREATE_SESSION_FAIL_ONCE__) {
        win.__MOCK_CREATE_SESSION_FAIL_ONCE__ = false;
        throw new Error("mock: couldn't create session");
      }
    }
    const session: HarnessSession = {
      id: `sess-mock-${this.sessions.length + 1}`,
      agentSessionId: null,
      boundWorkflowPath: null,
      harness: req.harness,
      cwd: req.cwd,
      title: req.cwd.split("/").filter(Boolean).pop() ?? req.cwd,
      status: "starting",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      // Mirrors the real server: portable continue only claims to have carried
      // context when a record for that id exists. The fixtures have records for
      // MOCK_SESSION_RECORDS' keys and nothing else.
      rehydratedFrom:
        req.rehydrateFrom && MOCK_SESSION_RECORDS[req.rehydrateFrom]
          ? req.rehydrateFrom
          : null,
      ready: false,
    };
    this.sessions = [...this.sessions, session];
    // Mirror the real server: create answers "starting", and the event bus
    // promotes the session to running/ready moments later. Without this, a
    // mock-created session would stay unready forever and gate the action
    // bar. Reads the CURRENT copy at fire time so a bind that landed in
    // between is never clobbered.
    const promote = (): void => {
      void import("./events").then(({ publishMockBusMessage }) => {
        const current = this.sessions.find((s) => s.id === session.id);
        if (!current || current.status === "exited") return;
        const promoted: HarnessSession = {
          ...current,
          status: "running",
          ready: true,
          lastActiveAt: new Date().toISOString(),
        };
        this.sessions = this.sessions.map((s) =>
          s.id === promoted.id ? promoted : s,
        );
        publishMockBusMessage({ type: "session.status", session: promoted });
      });
    };
    // Test-only: a session that never reaches ready on its own, so Playwright
    // can exercise the hold-the-prompt-until-agent-ready path (for example,
    // Claude login or Codex directory trust). The test fires readiness by hand
    // via window.__HARNESS_TEST__.promoteReady().
    const win =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as {
            __MOCK_WITHHOLD_READY__?: boolean;
            __HARNESS_TEST__?: Record<string, unknown>;
          });
    if (win?.__MOCK_WITHHOLD_READY__) {
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        promoteReady: promote,
      };
    } else {
      setTimeout(promote, 700);
    }
    return session;
  }

  async attachFile(
    id: string,
    req: AttachFileRequest,
  ): Promise<AttachFileResponse> {
    await delay();
    const session = this.sessions.find((item) => item.id === id);
    if (!session)
      throw new ApiError(404, "session not found", "session not found");

    const testWindow =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as {
            __MOCK_ATTACH_FILE_FAIL_ONCE__?: boolean;
          });
    if (testWindow?.__MOCK_ATTACH_FILE_FAIL_ONCE__) {
      testWindow.__MOCK_ATTACH_FILE_FAIL_ONCE__ = false;
      throw new ApiError(
        500,
        "attachment materialization failed",
        "attachment materialization failed",
      );
    }

    const match = /^data:([^;]+);base64,([\s\S]+)$/i.exec(req.dataUrl);
    if (!match)
      throw new ApiError(400, "invalid attachment", "invalid attachment");
    const filename = req.filename.split(/[\\/]/).pop() || "pasted-file";
    const response: AttachFileResponse = {
      path: `${session.cwd}/.sapiom/uploads/mock-${filename}`,
      mediaType: match[1]!,
      bytes: atob(match[2]!).length,
    };

    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
      };
      const previous =
        (win.__HARNESS_TEST__?.attachFileCalls as unknown[] | undefined) ?? [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        attachFileCalls: [...previous, { id, req, response }],
      };
    }
    return response;
  }

  async listSessions(): Promise<HarnessSession[]> {
    await delay();
    return this.sessions;
  }

  async sessionHistory(cwd: string): Promise<SessionSummary[]> {
    await delay();
    const searchExtras = isSearchFixturesEnabled()
      ? (MOCK_SEARCH_HISTORY[cwd] ?? [])
      : [];
    return [...(MOCK_HISTORY[cwd] ?? []), ...searchExtras];
  }

  async sessionRecord(id: string): Promise<SessionRecord | null> {
    await delay();
    // Null for an id with no fixture — the same "nothing recorded" answer the
    // real client returns for a 404, so the empty state is exercised too.
    return (
      this.plannerSessionRecords.get(id) ?? MOCK_SESSION_RECORDS[id] ?? null
    );
  }

  async resumeSession(id: string): Promise<HarnessSession> {
    await delay(300);
    const existing = this.sessions.find(
      (session) => session.agentSessionId === id || session.id === id,
    );
    if (!existing) throw new Error(`mock: no session to resume for ${id}`);
    const resumed = {
      ...existing,
      status: "running" as const,
      lastActiveAt: new Date().toISOString(),
    };
    this.sessions = this.sessions.map((session) =>
      session.id === resumed.id ? resumed : session,
    );
    return resumed;
  }

  /** Mirrors the real route: registers the transcript-only row as a session
   *  record and hands it straight back as running, so mock mode exercises the
   *  adopt path rather than the create-a-fresh-session fallback. */
  async adoptSession(req: AdoptSessionRequest): Promise<HarnessSession> {
    await delay(300);
    const existing = this.sessions.find(
      (session) =>
        session.agentSessionId === req.agentSessionId &&
        session.cwd === req.cwd,
    );
    const adopted: HarnessSession = {
      ...(existing ?? {
        id: `sess-adopted-${req.agentSessionId.slice(0, 8)}`,
        agentSessionId: req.agentSessionId,
        boundWorkflowPath: null,
        harness: req.harness,
        cwd: req.cwd,
        title: req.title,
        createdAt: req.lastActiveAt,
        exitCode: null,
      }),
      status: "running" as const,
      ready: true,
      lastActiveAt: new Date().toISOString(),
    };
    this.sessions = existing
      ? this.sessions.map((session) =>
          session.id === adopted.id ? adopted : session,
        )
      : [...this.sessions, adopted];
    return adopted;
  }

  async killSession(id: string): Promise<void> {
    await delay();
    this.sessions = this.sessions.map((session) =>
      session.id === id
        ? { ...session, status: "exited" as const, exitCode: 0 }
        : session,
    );
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
      };
      const previous =
        (win.__HARNESS_TEST__?.killSessionCalls as string[] | undefined) ?? [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        killSessionCalls: [...previous, id],
      };
    }
  }

  async injectInput(id: string, req: InjectInputRequest): Promise<void> {
    await delay();
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
        __MOCK_INJECT_FAIL_ONCE__?: boolean;
      };
      // Test-only 409 simulation: Playwright sets this flag before a submit to
      // exercise the reactive 409 path (reason shown, caller retains draft).
      // Consumed exactly once — cleared immediately so the next submit succeeds.
      if (win.__MOCK_INJECT_FAIL_ONCE__) {
        win.__MOCK_INJECT_FAIL_ONCE__ = false;
        throw new ApiError(
          409,
          `POST /api/sessions/${id}/input → 409: Session is still initialising`,
          "Session is still initialising",
        );
      }
      // Record the submission for Playwright to assert on — same pattern as
      // runMacro's lastMacroRun.
      const previous =
        (win.__HARNESS_TEST__?.injectInputCalls as
          | Array<{ id: string; req: InjectInputRequest }>
          | undefined) ?? [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        lastInjectInput: { id, req },
        injectInputCalls: [...previous, { id, req }],
      };
    }
  }

  async listWorkflows(): Promise<WorkflowInfo[]> {
    await delay();
    return this.workflows;
  }

  async getWorkflowGraph(workflowPath: string): Promise<WorkflowGraphResponse> {
    await delay(80);
    const workflow = this.workflows.find((item) => item.path === workflowPath);
    // 404 means "not a registered workflow" and NOTHING else — an agent whose
    // board is empty still answers 200. The mock keeps that distinction because
    // it is the one a consumer can get wrong invisibly.
    if (!workflow)
      throw new ApiError(404, "agent not found", "Agent not found");
    // e2e seam: drive the non-`ok` statuses the pane must render as DISTINCT
    // honest states. `preparing` is not a failure (a fresh scaffold with no
    // deps installed) and `empty` is not an error (absent ⇒ empty), so a test
    // has to be able to reach each one.
    const override =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              __MOCK_WORKFLOW_GRAPH__?: Record<
                string,
                { status: WorkflowGraphStatus; reason?: string | null }
              >;
            }
          ).__MOCK_WORKFLOW_GRAPH__?.[workflowPath]
        : undefined;
    const status = override?.status ?? "ok";
    const base = {
      path: workflow.path,
      name: workflow.name,
      enrichment: null,
      cached: false,
    };
    if (status !== "ok") {
      const reason = override?.reason ?? null;
      return {
        ...base,
        status,
        graph: null,
        reason,
        // The real route returns a renderable document for EVERY status — an
        // empty board is still a page, never a hole — so an empty string here
        // would be indistinguishable from a truncated body.
        document: mockWorkflowMessageDocument(
          status === "preparing"
            ? "Preparing your agent"
            : status === "empty"
              ? "Nothing rendered yet"
              : "Couldn't render this agent",
          reason,
        ),
      };
    }
    const graph = mockWorkflowGraph(workflow.name);
    return {
      ...base,
      status: "ok",
      graph,
      reason: null,
      document: mockWorkflowGraphDocument(workflow.name, graph),
    };
  }

  async getWorkflowInputContract(
    workflowPath: string,
  ): Promise<WorkflowInputContractResponse> {
    await delay(120);
    const workflow = this.workflows.find((item) => item.path === workflowPath);
    if (!workflow)
      throw new ApiError(404, "Agent not found", "Agent not found");
    if (typeof window !== "undefined") {
      const testWindow = window as unknown as {
        __MOCK_INPUT_CONTRACT_MODE__?: "throw" | "unavailable";
        __MOCK_INPUT_CONTRACT__?: WorkflowInputContractResponse;
      };
      if (testWindow.__MOCK_INPUT_CONTRACT__)
        return testWindow.__MOCK_INPUT_CONTRACT__;
      const mode = testWindow.__MOCK_INPUT_CONTRACT_MODE__;
      if (mode === "throw") {
        throw new ApiError(
          500,
          "GET /api/workflows/:id/input-contract → 500 (mock)",
          "Input contract could not be loaded",
        );
      }
      if (mode === "unavailable") {
        return {
          status: "unavailable",
          jsonSchema: null,
          example: {},
          reason: "Input contract extraction failed in the mock runtime.",
        };
      }
    }
    return {
      status: "available",
      jsonSchema: {
        type: "object",
        title: `${workflow.name} input`,
        properties: {
          topic: {
            type: "string",
            title: "Topic",
            description: "The subject this run should work on.",
            default: "indie game development",
          },
        },
        required: ["topic"],
      },
      example: { topic: "indie game development" },
    };
  }

  async connectWorkflow(path: string): Promise<WorkflowInfo> {
    await delay(250);
    const info: WorkflowInfo = {
      name: path.split("/").filter(Boolean).pop() ?? path,
      path,
      definitionId: null,
      definitionSlug: null,
      source: "connect",
    };
    this.workflows = [...this.workflows.filter((w) => w.path !== path), info];
    return info;
  }

  /**
   * The mock's stand-in for `POST /api/agents/move`.
   *
   * A SECOND GUARD, deliberately: the rail asks `planMove` before dispatching,
   * but the mover must not be the only thing between a bad destination and a
   * clobbered agent — and in the reference prototype it was, so anything
   * reaching the registry another way clobbered silently. The real server stats
   * the destination (`src/server/agent-move.ts`); the mock has no disk, so it
   * checks what the registry can see, which is the same guard minus the `stat`.
   *
   * The move is recorded rather than applied to this instance's fixtures — see
   * `mockMoves` for why there is exactly one log — and then announced as
   * `workflows.changed`, the same signal the real server broadcasts, so the rail
   * re-derives the tree from the new path through its normal refresh path.
   */
  async moveAgent(from: string, to: string): Promise<void> {
    recordAgentMove({ from, to });
    await delay(120);
    const refusal = refuseMove(
      this.workflows.map((workflow) => workflow.path),
      from,
      to,
    );
    if (refusal)
      throw new ApiError(
        409,
        "POST /api/agents/move \u2192 409 (mock)",
        refusal,
      );
    if (samePath(from, to)) return;
    mockMoves.push({ from, to });
    this.invalidateSystemGraphProjections();
    void import("./events").then(({ publishMockBusMessage }) => {
      publishMockBusMessage({ type: "workflows.changed" });
    });
  }

  /**
   * The mock's stand-in for `POST /api/agents/scaffold`.
   *
   * A SECOND GUARD, like the mock's mover beside it: the dialog validates the
   * name before it submits, but the create path must not be a thing only the
   * dialog can refuse. The real server owns the disk (`src/server/scaffold.ts`)
   * — the mock has none, so it checks what the registry can see, which is the
   * same guard set minus the `lstat`.
   *
   * The new agent JOINS the fixture list and `workflows.changed` is announced,
   * the same signal the real server broadcasts, so the rail shows the agent
   * before the caller opens a session on it — the criterion this endpoint
   * exists for, exercisable in a browser.
   */
  async scaffoldAgent(
    root: string,
    name: string,
    template = "default",
  ): Promise<AgentScaffoldResponse> {
    await delay(180);
    const refusal = refuseAgentName(name);
    if (refusal)
      throw new ApiError(
        400,
        "POST /api/agents/scaffold \u2192 400 (mock)",
        refusal,
      );
    // THE ROOT BARRIER, and the reason it is here: the real route only writes
    // into a folder the rail can show, and this mock originally skipped that
    // guard — so `templates.spec.ts` asserted a scaffold into
    // `<defaultProjectRoot>` succeeded while a fresh install would have been
    // refused at exactly that path. A mock that is missing a guard is a suite
    // that certifies the bug.
    if (!this.projectDirs().some((dir) => samePath(dir, root)))
      throw new ApiError(
        409,
        "POST /api/agents/scaffold \u2192 409 (mock)",
        `Can't create an agent in ${root} — Studio doesn't show that folder as a project.`,
      );
    const path = `${root.replace(/\/+$/, "")}/${name}`;
    if (this.workflows.some((workflow) => samePath(workflow.path, path)))
      throw new ApiError(
        409,
        "POST /api/agents/scaffold \u2192 409 (mock)",
        `${basenameOf(root)} already has an agent called ${name}.`,
      );
    this.workflows = [
      ...this.workflows,
      {
        name,
        path,
        definitionId: null,
        definitionSlug: null,
        source: "scan",
        // The real scaffold writes the starter's id into sapiom.json, and the
        // rail reads provenance from it.
        starterId: template,
      },
    ];
    recordCreateStep("scaffold", path);
    void import("./events").then(({ publishMockBusMessage }) => {
      publishMockBusMessage({ type: "workflows.changed" });
    });
    return { ok: true, path, name, template, dependenciesInstalled: true };
  }

  /**
   * The mock's twin of the server's `listProjectDirs`: the roots the rail can
   * show — stored recents, the host's default parent for new projects, and
   * every live session's cwd — plus the directories between a root and an
   * agent, which is where the Project axis draws its folder rows.
   */
  private projectDirs(): string[] {
    const roots = [
      // THIS instance's settings, not the fixture constant: a `fresh` mock has
      // no recents at all, which is the state the fresh-install bug lived in.
      ...this.settings.recentDirs,
      `${MOCK_LAUNCH_DIR}/projects`,
      ...this.sessions.map((session) => session.cwd),
    ];
    const dirs = new Set(roots);
    for (const workflow of this.workflows) {
      for (const root of roots) {
        if (!isWithinDir(root, workflow.path)) continue;
        let dir = parentOf(workflow.path);
        while (dir && isWithinDir(root, dir)) {
          dirs.add(dir);
          const parent = parentOf(dir);
          if (!parent || parent === dir) break;
          dir = parent;
        }
      }
    }
    return [...dirs];
  }

  async scanWorkflows(root: string): Promise<WorkflowScanOutcome> {
    await delay(250);
    // Honest mock: "found" means the fixture workflow actually lives under
    // the scanned root — scanning a folder with no agents finds nothing.
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const found = this.workflows.filter(
      (w) => w.path === root || w.path.startsWith(prefix),
    );
    // The mock can also reproduce the real walk's most confusing outcome — a
    // folder holding separate checkouts, where the scan legitimately finds
    // nothing — so the rail's explanation is exercisable in a browser.
    return { found, repositoryBoundaries: MOCK_SCAN_BOUNDARIES[root] ?? [] };
  }

  async listHarnesses(): Promise<HarnessEntry[]> {
    await delay(120);
    return MOCK_HARNESSES;
  }

  /**
   * The mock's stand-in for `<root>/.sapiom/studio-rail.json`.
   *
   * `localStorage`, keyed per project root, because the one thing this file has
   * to be tested for is what it looks like ACROSS a page load — and the bug it
   * exists to prevent lived in a mount effect, not in the serializer. A
   * per-instance Map would be wiped by every reload and could never see it.
   * Contents are the same text the server stores, so a spec asserting the
   * written shape is asserting the real shape.
   */
  private railStateKey(projectRoot: string): string {
    return `${MOCK_RAIL_STATE_PREFIX}${projectRoot.replace(/\/+$/, "")}`;
  }

  async getRailState(projectRoot: string): Promise<string | null> {
    await delay(60);
    // Test-only, mock mode only, matching __MOCK_SYSTEM_GRAPH_FAIL_ONCE__: a
    // read-only checkout or a 5xx on this route is the one case where "safe to
    // write" and "safe to draw" have different answers, and getting that wrong
    // leaves the rail naming every system while the map shows an unlabelled
    // blob. Reachable only by throwing the read.
    if (
      typeof window !== "undefined" &&
      (window as unknown as { __MOCK_RAIL_STATE_FAIL__?: boolean })
        .__MOCK_RAIL_STATE_FAIL__
    ) {
      throw new ApiError(500, "Rail state unreadable", "Rail state unreadable");
    }
    try {
      return window.localStorage.getItem(this.railStateKey(projectRoot));
    } catch {
      return null;
    }
  }

  /**
   * The store is written BEFORE the simulated latency, not after: two edits in
   * quick succession have to land in the order they were made, and awaiting
   * first let an earlier, slower write finish last — a reset that erased the
   * file followed by a pending save that put it straight back.
   */
  async saveRailState(projectRoot: string, raw: string): Promise<void> {
    recordRailStateWrite({ root: projectRoot, raw });
    try {
      window.localStorage.setItem(this.railStateKey(projectRoot), raw);
    } catch {
      // Private mode / quota: persistence is best-effort, the live state wins.
    }
    await delay(60);
  }

  async clearRailState(projectRoot: string): Promise<void> {
    recordRailStateWrite({ root: projectRoot, raw: null });
    try {
      window.localStorage.removeItem(this.railStateKey(projectRoot));
    } catch {
      // Same: nothing stored is the goal state either way.
    }
    await delay(60);
  }

  async listLaunchEdges(): Promise<StudioRailLaunchEdge[]> {
    await delay(120);
    return MOCK_LAUNCH_EDGES;
  }

  async listMacros(): Promise<MacroDef[]> {
    await delay();
    return MOCK_MACROS;
  }

  async runMacro(id: string, req: RunMacroRequest): Promise<void> {
    await delay(200);
    // Test-only escape hatch, mock mode only: MockApi has no other observable
    // effect, so Playwright reads this back to assert what a click actually
    // sent (e.g. that Visualize fires with no subject — it's one-click now).
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
      };
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        lastMacroRun: { id, req },
      };
    }
    // Demo nicety: the static build has no agent to render a canvas, so the
    // Visualize flow completes deterministically — a canvas.reload arrives
    // shortly after, and the pane loads the bundled demo canvas document.
    if (id === "visualize") {
      const { publishMockBusMessage } = await import("./events");
      setTimeout(() => {
        publishMockBusMessage({
          type: "canvas.reload",
          harnessSessionId: req.harnessSessionId,
        });
      }, 900);
    }
  }

  async getSettings(): Promise<HarnessSettings> {
    await delay();
    return this.settings;
  }

  async updateSettings(
    patch: Partial<HarnessSettings>,
  ): Promise<HarnessSettings> {
    // Persisted BEFORE the simulated latency, for the same reason
    // `saveRailState` is: dismissing the card hides it immediately, so a
    // reload can (and in the spec does) start before this delay resolves. A
    // write behind the delay would lose the dismiss to its own fixture.
    if (patch.helpSeen !== undefined) writeMockHelpSeen(patch.helpSeen);
    await delay();
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }

  async listDir(path?: string): Promise<FsListResponse> {
    await delay(120);
    if (mockErrorTargets().has("listDir")) {
      throw new ApiError(
        500,
        "GET /api/fs → 500 (mock)",
        "Could not read that directory",
      );
    }
    const requested = path && path.trim() ? path.trim() : MOCK_LAUNCH_DIR;
    // Walk up to the nearest ancestor the fixture tree actually has — lets the
    // caller distinguish "you're browsing X" from "you typed part of a name
    // inside X" by comparing the response's `path` to what it asked for.
    let normalized = requested;
    while (!(normalized in MOCK_FS_TREE) && normalized !== "/") {
      const segments = normalized.split("/").filter(Boolean);
      normalized =
        segments.length <= 1 ? "/" : "/" + segments.slice(0, -1).join("/");
    }
    if (!(normalized in MOCK_FS_TREE)) normalized = MOCK_LAUNCH_DIR;

    const names = MOCK_FS_TREE[normalized] ?? [];
    const segments = normalized.split("/").filter(Boolean);
    // Matches path.dirname("/") === "/" — root's own parent is itself, never null.
    const parent =
      normalized === "/"
        ? "/"
        : segments.length <= 1
          ? "/"
          : "/" + segments.slice(0, -1).join("/");
    return {
      path: normalized,
      parent,
      dirs: names.map((name) => {
        const dirPath =
          normalized === "/" ? `/${name}` : `${normalized}/${name}`;
        return {
          name,
          path: dirPath,
          // Derived from MOCK_WORKFLOWS (what exists on the mock DISK), not from
          // `this.workflows` (what the rail currently knows about). They are not
          // the same thing: a project can sit on disk unregistered — that is
          // precisely the case "I have a project" exists to handle — and keying
          // off registry state would leave every folder unbadged under
          // `?mockState=fresh`, making that flow untestable.
          hasAgentProject: MOCK_WORKFLOWS.some(
            (workflow) => workflow.path === dirPath,
          ),
        };
      }),
    };
  }

  async bindWorkflow(
    sessionId: string,
    workflowPath: string | null,
  ): Promise<HarnessSession> {
    await delay(150);
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
        __MOCK_BIND_WORKFLOW_FAIL_ONCE__?: boolean;
      };
      const previous =
        (win.__HARNESS_TEST__?.bindWorkflowCalls as unknown[] | undefined) ??
        [];
      const req = { sessionId, workflowPath };
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        lastBindWorkflow: { req },
        bindWorkflowCalls: [...previous, { req }],
      };
      if (win.__MOCK_BIND_WORKFLOW_FAIL_ONCE__) {
        win.__MOCK_BIND_WORKFLOW_FAIL_ONCE__ = false;
        throw new Error("mock: couldn't bind session");
      }
    }
    const existing = this.sessions.find((session) => session.id === sessionId);
    if (!existing) throw new Error(`mock: no session to bind for ${sessionId}`);
    const bound: HarnessSession = {
      ...existing,
      boundWorkflowPath: workflowPath,
    };
    this.sessions = this.sessions.map((session) =>
      session.id === sessionId ? bound : session,
    );
    return bound;
  }

  async listTemplates(): Promise<TemplateListResponse> {
    await delay(200);
    return { templates: MOCK_TEMPLATES, source: "live" };
  }

  async getAccountPlan(): Promise<AccountPlanView> {
    await delay(150);
    return MOCK_ACCOUNT_PLAN;
  }

  async getTemplate(id: string): Promise<TemplateDetailView> {
    await delay(150);
    const summary = MOCK_TEMPLATES.find((template) => template.id === id);
    if (!summary)
      throw new ApiError(
        404,
        `mock: no template ${id}`,
        `Template not found: ${id}`,
      );
    // Real per-template graphs (MOCK_TEMPLATE_GRAPHS) with the registry's actual
    // step names, so mock mode previews what live mode previews. A template with
    // no graph fixture falls back to a single entry node rather than inventing a
    // shape we would then assert against.
    const graph = MOCK_TEMPLATE_GRAPHS[summary.id] ?? {
      steps: [
        {
          name: "start",
          description: null,
          capabilities: summary.capabilities,
          kind: "entry",
          sublabel: "entry",
        },
      ],
      transitions: [],
    };
    return {
      ...summary,
      whatItDoes: summary.description,
      sourcePath: `examples/${summary.id}`,
      steps: graph.steps,
      transitions: graph.transitions,
      author: { name: "Sapiom", url: "https://sapiom.ai/" },
      useCases: [`Use ${summary.name} as a starting point.`],
      notes: "Mock notes — the real manifest ships with the template.",
      examples: [],
      requiredSecrets: [],
    };
  }

  // Scripted completed run for the demo leasing workflow. Per-step latency
  // and pass/fail only — the run inspector surfaces logs, latency, and
  // status, never cost.
  //
  // Test-only override: Playwright can set
  //   window.__MOCK_RUN_STATE__[executionId] = RunView
  // before announcing an execution.started to exercise run states (failed,
  // running, stub hygiene signals) that the default fixture doesn't cover.
  // The override is consumed once and cleared so subsequent polls use the
  // default — mirrors __MOCK_INJECT_FAIL_ONCE__'s established pattern.
  async getRunState(executionId: string): Promise<RunView> {
    await delay(120);
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __MOCK_RUN_STATE__?: Record<string, RunView>;
      };
      const override = win.__MOCK_RUN_STATE__?.[executionId];
      if (override) {
        delete win.__MOCK_RUN_STATE__![executionId];
        return override;
      }
    }
    // A run the user just STARTED (Run button → run() mints exec-mock-prod-*)
    // advances step-by-step on a wall clock so the Steps view visibly moves.
    // Every other id (the on-load demo receipt, Playwright's authored ids) keeps
    // the terminal fixture below — several specs depend on that first poll being
    // terminal so the poller stops.
    if (executionId.startsWith("exec-mock-prod-")) {
      let startedAt = this.progressiveRunStart.get(executionId);
      if (startedAt === undefined) {
        startedAt = Date.now();
        this.progressiveRunStart.set(executionId, startedAt);
      }
      return progressiveLeasingRun(executionId, Date.now() - startedAt);
    }
    return {
      executionId,
      status: "completed",
      steps: LEASING_RUN_STEPS.map((step) => ({
        id: step.id,
        name: step.name,
        status: "passed" as const,
        latencyMs: step.latencyMs,
      })),
    };
  }

  // A deterministic OFFLINE stub run: emits per-step traces (logs + IO, no
  // cost/latency — a local trace carries none) then a terminal summary, spaced
  // so the inspector visibly lights up step-by-step. Lets the mock/demo build
  // and Playwright exercise the run-local inspector with no server, mirroring
  // the real NDJSON stream's ordering (traces first, terminal line last).
  async runLocal(
    args: RunLocalArgs,
    onLine: (line: RunLocalLine) => void,
  ): Promise<void> {
    this.recordDirectAction("runLocal", args);
    const traces: LocalStepTrace[] = [
      {
        step: "intake",
        attempt: 1,
        input: { applicant: "Ada" },
        status: "succeeded",
        output: { ok: true },
        logs: [{ level: "info", msg: "parsed application" }],
      },
      {
        step: "screen",
        attempt: 1,
        input: { ok: true },
        status: "succeeded",
        output: { score: 720 },
        logs: [{ level: "info", msg: "stubbed credit check" }],
      },
      {
        step: "approve",
        attempt: 1,
        input: { score: 720 },
        status: "succeeded",
        output: { approved: true },
        logs: [],
      },
    ];
    for (const trace of traces) {
      await delay(140);
      onLine({
        kind: "step",
        phase: "started",
        trace: {
          step: trace.step,
          attempt: trace.attempt,
          input: trace.input,
          status: "running",
          startedAt: new Date().toISOString(),
          logs: [],
        },
      });
      await delay(140);
      onLine({
        kind: "step",
        phase: "settled",
        trace: {
          ...trace,
          startedAt: new Date(Date.now() - 140).toISOString(),
          finishedAt: new Date().toISOString(),
          sharedStateAfter: { lastStep: trace.step },
          directive:
            trace.step === "approve"
              ? { kind: "terminate" }
              : {
                  kind: "continue",
                  stepName: trace.step === "intake" ? "screen" : "approve",
                  input: trace.output,
                },
        },
      });
    }
    await delay(140);
    onLine({
      kind: "summary",
      outcome: "completed",
      output: { approved: true },
    });
  }

  // The direct actions have no network in mock mode: they synthesize the same
  // NDJSON shapes the real server streams, drive `onLine`/`onEvent` so the
  // consuming UI is exercised, and record the call on __HARNESS_TEST__ so
  // Playwright can assert the button hit the DIRECT path — never a pty inject
  // (lastMacroRun) — which is the whole point of the direct-action button handler.

  async deploy(
    workflowPath: string,
    onEvent?: StreamLineHandler<DeployStreamEvent>,
  ): Promise<DeployStreamEvent> {
    this.recordDirectAction("deploy", { workflowPath });
    // Mirror the real server: an unlinked workflow is linked (agent created)
    // before the build, so mock mode exercises the same two-phase stream.
    const target = this.workflows.find((w) => w.path === workflowPath);
    if (target && target.definitionId == null) {
      const linking: DeployStreamEvent = {
        phase: "linking",
        name: target.name,
      };
      onEvent?.(linking);
      await delay(200);
    }
    // A first link persists before its first build finishes. Model that exact
    // boundary so failure tests cannot accidentally treat definitionId as a
    // ready deployment.
    this.workflows = this.workflows.map((w) =>
      w.path === workflowPath
        ? {
            ...w,
            definitionId: w.definitionId ?? 4242,
            definitionSlug: w.definitionSlug ?? "mock-agent",
            activeBuildRunId: "mock-build-1",
            activeBuildRunStatus: "building",
          }
        : w,
    );
    const building: DeployStreamEvent = {
      phase: "building",
      definitionId: "mock-def",
    };
    onEvent?.(building);
    await delay(400);
    // Test-only failure mode: `?mockError=deploy` makes the stream end with a
    // phase:"error" terminal event so Playwright can exercise the deploy-failed
    // affordance (lastDeployError persists, chip reads "Deploy failed",
    // prod-run disabled-reason reads "Last deploy failed — retry Deploy").
    if (mockErrorTargets().has("deploy")) {
      this.workflows = this.workflows.map((w) =>
        w.path === workflowPath ? { ...w, activeBuildRunStatus: "failed" } : w,
      );
      const failed: DeployStreamEvent = {
        phase: "error",
        code: "BUILD_FAILED",
        message: "mock build error",
        hint: "check your agent definition",
      };
      onEvent?.(failed);
      return failed;
    }
    const ready: DeployStreamEvent = {
      phase: "ready",
      definitionId: "mock-def",
      buildRunId: "mock-build-1",
      status: "succeeded",
    };
    onEvent?.(ready);
    // Mirror the definition-detail projection after a successful cloud build.
    this.workflows = this.workflows.map((w) =>
      w.path === workflowPath
        ? {
            ...w,
            activeBuildRunId: "mock-build-1",
            activeBuildRunStatus: "ready",
          }
        : w,
    );
    return ready;
  }

  async run(req: {
    definitionId: string;
    input?: unknown;
  }): Promise<RunResponse> {
    this.recordDirectAction("run", req);
    await delay(200);
    // A fresh, non-"local" id so the run-state fixture returns the prod
    // steps and the inspector poller has something to follow.
    return { executionId: `exec-mock-prod-${Date.now()}` };
  }

  /** Test-only escape hatch (mock mode only): record a direct-action call so
   *  Playwright can assert the button used the DIRECT route rather than the pty
   *  inject path. Same pattern as lastMacroRun/lastInjectInput. */
  private recordDirectAction(
    action: "deploy" | "run" | "runLocal",
    req: unknown,
  ): void {
    if (typeof window === "undefined") return;
    const win = window as unknown as {
      __HARNESS_TEST__?: Record<string, unknown>;
    };
    const prev = (win.__HARNESS_TEST__?.directActions as unknown[]) ?? [];
    win.__HARNESS_TEST__ = {
      ...(win.__HARNESS_TEST__ ?? {}),
      directActions: [...prev, { action, req }],
      lastDirectAction: { action, req },
    };
  }
}

/**
 * Intercepts fetch("/api/track") in mock mode so Playwright can assert that
 * track() calls fire without a real server. Attach BEFORE the app mounts.
 * Accumulated events are available on window.__HARNESS_TEST__.trackEvents.
 */
export function interceptMockTrack(): void {
  if (!isMockMode()) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === "/api/track" && init?.method === "POST") {
      const win = window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown>;
      };
      let body: unknown;
      try {
        body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
      } catch {
        body = {};
      }
      const prev = (win.__HARNESS_TEST__?.trackEvents as unknown[]) ?? [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        trackEvents: [...prev, body],
      };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
}

export function createApi(): HarnessApi {
  return isMockMode() ? new MockApi() : new RealApi();
}
