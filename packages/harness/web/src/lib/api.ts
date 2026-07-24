/**
 * Typed REST client for the harness server (see the "REST API surface"
 * section of ../../../src/shared/types.ts). Gated at this layer: with
 * `VITE_MOCK=1` the whole app runs against in-memory fixtures and never
 * touches the network — this is what lets the SPA build ahead of a running
 * server.
 */
import type {
  AppState,
  AttachImageRequest,
  AttachImageResponse,
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
  SampleProjectSeedResponse,
  SessionSummary,
  RunView,
  WorkflowInfo,
} from "@shared/types";

import type { LocalStepTrace, LocalRunOutcome } from "@sapiom/agent-core";

import { MOCK_FS_TREE, MOCK_HARNESSES, MOCK_HISTORY, MOCK_LAUNCH_DIR, MOCK_MACROS, MOCK_SAMPLE_PROJECT_ROOT, MOCK_SESSIONS, MOCK_SETTINGS, MOCK_WORKFLOWS } from "./mock-data";

/**
 * Body for `POST /api/runs/local` — run the agent project at `sourceDir`
 * entirely offline against stub capabilities. `sourceDir` is the only required
 * field; the rest are forwarded to the run-local bootstrap as-is. Needs no API
 * key and makes no network call (zero cost) — mirrors the server's
 * `RunLocalRequest` without importing a server module into the browser bundle.
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
 * trace (a {@link LocalStepTrace}, discriminated by the ABSENCE of `kind`) or a
 * terminal line: a `summary` for a run that executed (carrying the outcome and
 * the two stub-hygiene signals), or an `error` for a run that could not be
 * invoked at all. The shapes mirror the bootstrap's own wire contract.
 */
export type RunLocalLine =
  | ({ kind?: undefined } & LocalStepTrace)
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
 * `DeployStreamEvent` in src/server/actions.ts): a `building` line up front,
 * then exactly one terminal `ready` | `error` line closing the stream.
 */
export type DeployStreamEvent =
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
  return isMockMode() && new URLSearchParams(window.location.search).get("mockState") === "fresh";
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
  const raw = new URLSearchParams(window.location.search).get("mockError") ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** `session.boundWorkflowPath` is nullable already, but keeps callers safe against a missing session. */
export function boundWorkflowPathOf(session: HarnessSession | null | undefined): string | null {
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

/** Read once at module load: `window.__HARNESS__ = {token}` (baked in by the server), falling back to `?token=`. */
export function getBootToken(): string {
  const injected = (window as unknown as { __HARNESS__?: { token?: string } }).__HARNESS__;
  if (injected?.token) return injected.token;
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

/** Response from GET /api/auth/status — live auth state from the server. */
export interface AuthStatusResponse {
  authenticated: boolean;
  organizationName: string | null;
}

/** Response from POST /api/auth/start — async kick-off only. */
export interface AuthStartResponse {
  started: boolean;
}

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
  createSession(req: CreateSessionRequest): Promise<HarnessSession>;
  listSessions(): Promise<HarnessSession[]>;
  sessionHistory(cwd: string): Promise<SessionSummary[]>;
  resumeSession(id: string): Promise<HarnessSession>;
  killSession(id: string): Promise<void>;
  injectInput(id: string, req: InjectInputRequest): Promise<void>;
  /** Attach an image (composer picker/paste/drop) to a session: the server
   *  writes it into the project dir and relays its path into the agent's pty.
   *  Only offered when the session's HarnessEntry declares imageInput — the
   *  harness-launch server (eebb95c) has no /image route at all. */
  attachImage(id: string, req: AttachImageRequest): Promise<AttachImageResponse>;
  listWorkflows(): Promise<WorkflowInfo[]>;
  connectWorkflow(path: string): Promise<WorkflowInfo>;
  scanWorkflows(root: string): Promise<WorkflowInfo[]>;
  /** Adapter registry (GET /api/harnesses): every known harness with its
   *  mode/installed/experimental flags plus per-agent Sapiom MCP install
   *  instructions — the new-session picker and MCP setup block feed on it. */
  listHarnesses(): Promise<HarnessEntry[]>;
  listMacros(): Promise<MacroDef[]>;
  runMacro(id: string, req: RunMacroRequest): Promise<void>;
  getSettings(): Promise<HarnessSettings>;
  updateSettings(patch: Partial<HarnessSettings>): Promise<HarnessSettings>;
  listDir(path?: string): Promise<FsListResponse>;
  bindWorkflow(sessionId: string, workflowPath: string | null): Promise<HarnessSession>;
  /** Seeds (or reuses) the bundled example project; the caller follows up
   *  with a normal createSession against the returned root. */
  seedSampleProject(): Promise<SampleProjectSeedResponse>;
  /** Live run render state (upstream feat/harness-runtime-analytics):
   *  GET /api/runs/:id/state = inspect -> decode -> renderRunState. Poll
   *  after an execution.started bus message until the run is terminal. */
  getRunState(executionId: string): Promise<RunView>;
  /**
   * Run the workflow at `args.sourceDir` OFFLINE against stub capabilities and
   * stream its NDJSON result (`POST /api/runs/local`): `onLine` is called once
   * per parsed line, in order — each per-step {@link LocalStepTrace} as it
   * arrives, then a terminal `summary` (or `error`) line. Resolves when the
   * stream ends; rejects only on a transport failure (never on a failed *run* —
   * a failed run is a normal terminal line). Fully offline: no key, no cost.
   */
  runLocal(args: RunLocalArgs, onLine: (line: RunLocalLine) => void): Promise<void>;
  /**
   * Deploy the agent linked to `workflowPath` (Deploy button) — POST
   * /api/workflows/:id/deploy. The server holds the API key and drives the
   * build; NO Claude Code, no user LLM credits. `onEvent` fires per NDJSON
   * line as the build streams (`building` → terminal `ready`/`error`); the
   * promise resolves with the terminal event. Rejects (ApiError) only on the
   * request itself failing (e.g. 409 not-linked) — a build *failure* resolves
   * with a `phase: "error"` terminal event, since the request succeeded.
   */
  deploy(workflowPath: string, onEvent?: StreamLineHandler<DeployStreamEvent>): Promise<DeployStreamEvent>;
  /**
   * Start a real prod execution (Prod-run button) — POST /api/runs. Runs
   * server-side with the held key; NO Claude Code. Returns the new
   * `{ executionId }`, which the caller hands to the run-inspector poller.
   */
  run(req: { definitionId: string; input?: unknown }): Promise<RunResponse>;
}

class RealApi implements HarnessApi {
  startAuth(): Promise<AuthStartResponse> {
    return this.request<AuthStartResponse>("/api/auth/start", { method: "POST" });
  }

  disconnect(): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/api/auth/disconnect", { method: "POST" });
  }

  authStatus(): Promise<AuthStatusResponse> {
    return this.request<AuthStatusResponse>("/api/auth/status");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
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
        if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
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
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  getState(): Promise<AppState> {
    return this.request<AppState>("/api/state");
  }

  createSession(req: CreateSessionRequest): Promise<HarnessSession> {
    return this.request<HarnessSession>("/api/sessions", { method: "POST", body: JSON.stringify(req) });
  }

  listSessions(): Promise<HarnessSession[]> {
    return this.request<HarnessSession[]>("/api/sessions");
  }

  sessionHistory(cwd: string): Promise<SessionSummary[]> {
    return this.request<SessionSummary[]>(`/api/sessions/history?cwd=${encodeURIComponent(cwd)}`);
  }

  resumeSession(id: string): Promise<HarnessSession> {
    return this.request<HarnessSession>(`/api/sessions/${encodeURIComponent(id)}/resume`, { method: "POST" });
  }

  async killSession(id: string): Promise<void> {
    await this.request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async injectInput(id: string, req: InjectInputRequest): Promise<void> {
    await this.request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/input`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  attachImage(id: string, req: AttachImageRequest): Promise<AttachImageResponse> {
    return this.request<AttachImageResponse>(`/api/sessions/${encodeURIComponent(id)}/image`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  listWorkflows(): Promise<WorkflowInfo[]> {
    return this.request<WorkflowInfo[]>("/api/workflows");
  }

  connectWorkflow(path: string): Promise<WorkflowInfo> {
    return this.request<WorkflowInfo>("/api/workflows/connect", { method: "POST", body: JSON.stringify({ path }) });
  }

  scanWorkflows(root: string): Promise<WorkflowInfo[]> {
    return this.request<WorkflowInfo[]>("/api/workflows/scan", { method: "POST", body: JSON.stringify({ root }) });
  }

  listHarnesses(): Promise<HarnessEntry[]> {
    return this.request<HarnessEntry[]>("/api/harnesses");
  }

  listMacros(): Promise<MacroDef[]> {
    return this.request<MacroDef[]>("/api/macros");
  }

  async runMacro(id: string, req: RunMacroRequest): Promise<void> {
    await this.request<{ ok: true }>(`/api/macros/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  getSettings(): Promise<HarnessSettings> {
    return this.request<HarnessSettings>("/api/settings");
  }

  updateSettings(patch: Partial<HarnessSettings>): Promise<HarnessSettings> {
    return this.request<HarnessSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
  }

  listDir(path?: string): Promise<FsListResponse> {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.request<FsListResponse>(`/api/fs/list${query}`);
  }

  bindWorkflow(sessionId: string, workflowPath: string | null): Promise<HarnessSession> {
    const body: BindWorkflowRequest = { workflowPath };
    return this.request<HarnessSession>(`/api/sessions/${encodeURIComponent(sessionId)}/workflow`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  seedSampleProject(): Promise<SampleProjectSeedResponse> {
    return this.request<SampleProjectSeedResponse>("/api/sample-project", { method: "POST" });
  }

  getRunState(executionId: string): Promise<RunView> {
    return this.request<RunView>(`/api/runs/${encodeURIComponent(executionId)}/state`);
  }

  async runLocal(args: RunLocalArgs, onLine: (line: RunLocalLine) => void): Promise<void> {
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
      throw new ApiError(res.status, `POST /api/runs/local → ${res.status}${body ? `: ${body}` : ""}`, undefined);
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

  async run(req: { definitionId: string; input?: unknown }): Promise<RunResponse> {
    return this.request<RunResponse>("/api/runs", { method: "POST", body: JSON.stringify(req) });
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
        if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
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
export function splitNdjson(buffer: string, flush: boolean): { lines: string[]; rest: string } {
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as RunLocalLine;
}

/** The terminal deploy event (the `ready`/`error` line), or a synthesized
 *  `error` when the stream ended without one — the button always gets a
 *  definite outcome. */
export function terminalDeployEvent(events: DeployStreamEvent[]): DeployStreamEvent {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.phase === "ready" || event.phase === "error") return event;
  }
  return { phase: "error", code: "NO_OUTPUT", message: "deploy produced no terminal status" };
}

const delay = (ms = 180): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory, mutable copies of the fixtures — mutations persist for the tab's lifetime, reset on reload. */
class MockApi implements HarnessApi {
  // Mock auth state: flipped by startAuth() / disconnect() so D7 e2e tests
  // can drive the full sign-in flow deterministically without a real browser.
  private _authenticated = false;
  private _organizationName: string | null = null;

  async startAuth(): Promise<AuthStartResponse> {
    // Record the call for Playwright assertions (same pattern as runMacro/deploy).
    if (typeof window !== "undefined") {
      const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
      win.__HARNESS_TEST__ = { ...(win.__HARNESS_TEST__ ?? {}), lastAuthStart: Date.now() };
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
    return { authenticated: this._authenticated, organizationName: this._organizationName };
  }


  // `?mockState=fresh` = brand-new install: nothing yet, firstRun set — see isFreshMockState().
  private readonly fresh = isFreshMockState();
  // `?mockConsentSource=prompted` mirrors a user who answered yes at the TTY prompt:
  // telemetryOptIn starts true so the chip shows "analytics on" from the first render.
  private readonly promptedConsent =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("mockConsentSource") === "prompted";
  private sessions = this.fresh ? [] : MOCK_SESSIONS.map((session) => ({ ...session }));
  private workflows = this.fresh ? [] : MOCK_WORKFLOWS.map((workflow) => ({ ...workflow }));
  private settings: HarnessSettings = this.fresh
    ? { ...MOCK_SETTINGS, recentDirs: [] }
    : {
        ...MOCK_SETTINGS,
        recentDirs: [...MOCK_SETTINGS.recentDirs],
        ...(this.promptedConsent ? { telemetryOptIn: true } : {}),
      };

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
      const boot401 = new URLSearchParams(window.location.search).get("mockBoot401") === "1";
      if (boot401) {
        // NOTE: relies on React 18 StrictMode's double-invoke of the boot effect;
        // valid only in VITE_MOCK=1 + the Vite dev server.
        // Strategy: count calls. Fail on call #2 (the real boot fetch). Calls
        // #1 (StrictMode's discarded run) and #3+ (Retry) succeed normally.
        // This lets the e2e assert: 401 → ConnectivityScreen → Retry → shell.
        const prev = win.__MOCK_BOOT_401_CALL_COUNT__ ?? 0;
        win.__MOCK_BOOT_401_CALL_COUNT__ = prev + 1;
        if (prev + 1 === 2) {
          throw new ApiError(401, "GET /api/state → 401: credential rejected (mock)", "credential rejected");
        }
      }
    }
    // mockConsentSource query param lets Playwright exercise all chip states:
    //   ?mockConsentSource=env-forced-off  → "analytics off (env)" chip
    //   ?mockConsentSource=default-silent  → shows TelemetryNotice
    //   ?mockConsentSource=stored-explicit → off chip (telemetryOptIn=false)
    //   ?mockConsentSource=prompted        → on chip (telemetryOptIn=true in mock)
    const mockConsentSource = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("mockConsentSource") as AppState["consentSource"] ?? "stored-explicit"
      : "stored-explicit";
    const mockEnvReason = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("mockEnvReason") ?? null
      : null;
    // When consent was answered via a TTY prompt ("prompted"), the user
    // necessarily said yes — mirror that in the mock so the chip shows "on".
    const telemetryOptIn =
      mockConsentSource === "prompted" ? true : this.settings.telemetryOptIn;
    return {
      version: "0.0.1-mock",
      authenticated: true,
      userId: "user_mock",
      organizationName: "Acme (mock)",
      telemetryOptIn,
      sessions: this.sessions,
      workflows: this.workflows,
      macros: MOCK_MACROS,
      launchDir: MOCK_LAUNCH_DIR,
      consentSource: mockConsentSource,
      ...(mockEnvReason ? { consentEnvReason: mockEnvReason } : {}),
      ...(this.fresh ? { firstRun: true } : {}),
    };
  }

  async createSession(req: CreateSessionRequest): Promise<HarnessSession> {
    await delay(300);
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
      ready: false,
    };
    this.sessions = [...this.sessions, session];
    // Mirror the real server: create answers "starting", and the event bus
    // promotes the session to running/ready moments later. Without this, a
    // mock-created session would stay unready forever and gate the action
    // bar. Reads the CURRENT copy at fire time so a bind that landed in
    // between is never clobbered.
    setTimeout(() => {
      void import("./events").then(({ publishMockBusMessage }) => {
        const current = this.sessions.find((s) => s.id === session.id);
        if (!current || current.status === "exited") return;
        const promoted: HarnessSession = {
          ...current,
          status: "running",
          ready: true,
          lastActiveAt: new Date().toISOString(),
        };
        this.sessions = this.sessions.map((s) => (s.id === promoted.id ? promoted : s));
        publishMockBusMessage({ type: "session.status", session: promoted });
      });
    }, 700);
    return session;
  }

  async listSessions(): Promise<HarnessSession[]> {
    await delay();
    return this.sessions;
  }

  async sessionHistory(cwd: string): Promise<SessionSummary[]> {
    await delay();
    return MOCK_HISTORY[cwd] ?? [];
  }

  async resumeSession(id: string): Promise<HarnessSession> {
    await delay(300);
    const existing = this.sessions.find((session) => session.agentSessionId === id || session.id === id);
    if (!existing) throw new Error(`mock: no session to resume for ${id}`);
    const resumed = { ...existing, status: "running" as const, lastActiveAt: new Date().toISOString() };
    this.sessions = this.sessions.map((session) => (session.id === resumed.id ? resumed : session));
    return resumed;
  }

  async killSession(id: string): Promise<void> {
    await delay();
    this.sessions = this.sessions.map((session) =>
      session.id === id ? { ...session, status: "exited" as const, exitCode: 0 } : session,
    );
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
        throw new ApiError(409, `POST /api/sessions/${id}/input → 409: Session is still initialising`, "Session is still initialising");
      }
      // Record the submission for Playwright to assert on — same pattern as
      // runMacro's lastMacroRun and seedSampleProject's lastSampleSeed.
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        lastInjectInput: { id, req },
      };
    }
  }

  async attachImage(id: string, req: AttachImageRequest): Promise<AttachImageResponse> {
    await delay();
    const mediaType = /^data:([^;]+);/.exec(req.dataUrl)?.[1] ?? "image/png";
    // base64 → decoded size: 4 chars encode 3 bytes.
    const bytes = Math.max(0, Math.floor((req.dataUrl.split(",")[1]?.length ?? 0) * 0.75));
    const response: AttachImageResponse = {
      path: `/mock/cwd/.sapiom/uploads/${id}-${req.filename ?? "image"}`,
      mediaType: mediaType as AttachImageResponse["mediaType"],
      bytes,
    };
    // Test-only escape hatch, mock mode only — same pattern as lastInjectInput:
    // Playwright reads this back to assert an attach actually fired.
    if (typeof window !== "undefined") {
      const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
      const prev = (win.__HARNESS_TEST__?.attachImageCalls as unknown[]) ?? [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        attachImageCalls: [...prev, { id, filename: req.filename, mediaType }],
      };
    }
    return response;
  }

  async listWorkflows(): Promise<WorkflowInfo[]> {
    await delay();
    return this.workflows;
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

  async scanWorkflows(root: string): Promise<WorkflowInfo[]> {
    await delay(250);
    // Honest mock: "found" means the fixture workflow actually lives under
    // the scanned root — scanning a folder with no agents finds nothing.
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return this.workflows.filter((w) => w.path === root || w.path.startsWith(prefix));
  }

  async listHarnesses(): Promise<HarnessEntry[]> {
    await delay(120);
    return MOCK_HARNESSES;
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
      const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
      win.__HARNESS_TEST__ = { ...(win.__HARNESS_TEST__ ?? {}), lastMacroRun: { id, req } };
    }
    // Demo nicety: the static build has no agent to render a canvas, so the
    // Visualize flow completes deterministically — a canvas.reload arrives
    // shortly after, and the pane loads the bundled demo canvas document.
    if (id === "visualize") {
      const { publishMockBusMessage } = await import("./events");
      setTimeout(() => {
        publishMockBusMessage({ type: "canvas.reload", harnessSessionId: req.harnessSessionId });
      }, 900);
    }
  }

  async getSettings(): Promise<HarnessSettings> {
    await delay();
    return this.settings;
  }

  async updateSettings(patch: Partial<HarnessSettings>): Promise<HarnessSettings> {
    await delay();
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }

  async listDir(path?: string): Promise<FsListResponse> {
    await delay(120);
    if (mockErrorTargets().has("listDir")) {
      throw new ApiError(500, "GET /api/fs → 500 (mock)", "Could not read that directory");
    }
    const requested = path && path.trim() ? path.trim() : MOCK_LAUNCH_DIR;
    // Walk up to the nearest ancestor the fixture tree actually has — lets the
    // caller distinguish "you're browsing X" from "you typed part of a name
    // inside X" by comparing the response's `path` to what it asked for.
    let normalized = requested;
    while (!(normalized in MOCK_FS_TREE) && normalized !== "/") {
      const segments = normalized.split("/").filter(Boolean);
      normalized = segments.length <= 1 ? "/" : "/" + segments.slice(0, -1).join("/");
    }
    if (!(normalized in MOCK_FS_TREE)) normalized = MOCK_LAUNCH_DIR;

    const names = MOCK_FS_TREE[normalized] ?? [];
    const segments = normalized.split("/").filter(Boolean);
    // Matches path.dirname("/") === "/" — root's own parent is itself, never null.
    const parent = normalized === "/" ? "/" : segments.length <= 1 ? "/" : "/" + segments.slice(0, -1).join("/");
    return {
      path: normalized,
      parent,
      dirs: names.map((name) => ({ name, path: normalized === "/" ? `/${name}` : `${normalized}/${name}` })),
    };
  }

  async bindWorkflow(sessionId: string, workflowPath: string | null): Promise<HarnessSession> {
    await delay(150);
    const existing = this.sessions.find((session) => session.id === sessionId);
    if (!existing) throw new Error(`mock: no session to bind for ${sessionId}`);
    const bound: HarnessSession = { ...existing, boundWorkflowPath: workflowPath };
    this.sessions = this.sessions.map((session) => (session.id === sessionId ? bound : session));
    return bound;
  }

  async seedSampleProject(): Promise<SampleProjectSeedResponse> {
    await delay(300);
    const response: SampleProjectSeedResponse = {
      root: MOCK_SAMPLE_PROJECT_ROOT,
      projectDir: `${MOCK_SAMPLE_PROJECT_ROOT}/order-triage`,
      created: true,
    };
    // Test-only escape hatch, mock mode only — same pattern as runMacro's
    // lastMacroRun: seeding has no other observable effect in mock mode, so
    // Playwright reads this back to assert the click actually seeded.
    if (typeof window !== "undefined") {
      const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
      win.__HARNESS_TEST__ = { ...(win.__HARNESS_TEST__ ?? {}), lastSampleSeed: response };
    }
    return response;
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
    return {
      executionId,
      status: "completed",
      steps: [
        { id: "intake", name: "intake", status: "passed" as const, latencyMs: 240 },
        { id: "screen", name: "screen", status: "passed" as const, latencyMs: 610 },
        { id: "credit-check", name: "credit-check", status: "passed" as const, latencyMs: 1900 },
        { id: "approve", name: "approve", status: "passed" as const, latencyMs: 130 },
        { id: "draft-lease", name: "draft-lease", status: "passed" as const, latencyMs: 800 },
      ],
    };
  }

  // A deterministic OFFLINE stub run: emits per-step traces (logs + IO, no
  // cost/latency — a local trace carries none) then a terminal summary, spaced
  // so the inspector visibly lights up step-by-step. Lets the mock/demo build
  // and Playwright exercise the run-local inspector with no server, mirroring
  // the real NDJSON stream's ordering (traces first, terminal line last).
  //
  // Test-only failure mode: `?mockError=runLocalInput` makes the run emit an
  // error line with a missing-input validation message so Playwright can verify
  // the run-first input dialog opens reactively.
  async runLocal(args: RunLocalArgs, onLine: (line: RunLocalLine) => void): Promise<void> {
    this.recordDirectAction("runLocal", { sourceDir: args.sourceDir, input: args.input });
    if (mockErrorTargets().has("runLocalInput")) {
      await delay(140);
      onLine({
        kind: "error",
        outcome: "failed",
        error:
          "Input for step 'research' failed validation: topic: must have required property 'topic'",
      });
      return;
    }
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
      onLine(trace);
    }
    await delay(140);
    onLine({ kind: "summary", outcome: "completed", output: { approved: true } });
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
    const building: DeployStreamEvent = { phase: "building", definitionId: "mock-def" };
    onEvent?.(building);
    await delay(400);
    // Test-only failure mode: `?mockError=deploy` makes the stream end with a
    // phase:"error" terminal event so Playwright can exercise the deploy-failed
    // affordance (lastDeployError persists, chip reads "Deploy failed",
    // prod-run disabled-reason reads "Last deploy failed — retry Deploy").
    if (mockErrorTargets().has("deploy")) {
      const failed: DeployStreamEvent = {
        phase: "error",
        code: "BUILD_FAILED",
        message: "mock build error",
        hint: "check your workflow definition",
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
    // Mirror the real server: a successful deploy links the workflow, so its
    // definitionId flips. Reflect that in the fixture so the Draft→Deployed
    // chip and the deploy-gated actions light up after a mock deploy.
    this.workflows = this.workflows.map((w) =>
      w.path === workflowPath && w.definitionId == null
        ? { ...w, definitionId: 4242, definitionSlug: w.definitionSlug ?? "mock-agent" }
        : w,
    );
    return ready;
  }

  async run(req: { definitionId: string; input?: unknown }): Promise<RunResponse> {
    this.recordDirectAction("run", req);
    await delay(200);
    // Test-only failure mode: `?mockError=prodRunInput` makes the API reject
    // with a missing-input validation error so Playwright can verify the run-first
    // dialog opens reactively for prod runs.
    if (mockErrorTargets().has("prodRunInput")) {
      throw new ApiError(
        422,
        "must have required property 'topic'",
        "must have required property 'topic'",
      );
    }
    // A fresh, non-"local" id so the run-state fixture returns the prod
    // steps and the inspector poller has something to follow.
    return { executionId: `exec-mock-prod-${Date.now()}` };
  }

  /** Test-only escape hatch (mock mode only): record a direct-action call so
   *  Playwright can assert the button used the DIRECT route rather than the pty
   *  inject path. Same pattern as lastMacroRun/lastInjectInput. */
  private recordDirectAction(action: "deploy" | "run" | "runLocal", req: unknown): void {
    if (typeof window === "undefined") return;
    const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
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
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/track" && init?.method === "POST") {
      const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
      let body: unknown;
      try {
        body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
      } catch {
        body = {};
      }
      const prev = (win.__HARNESS_TEST__?.trackEvents as unknown[]) ?? [];
      win.__HARNESS_TEST__ = { ...(win.__HARNESS_TEST__ ?? {}), trackEvents: [...prev, body] };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  };
}

export function createApi(): HarnessApi {
  return isMockMode() ? new MockApi() : new RealApi();
}
