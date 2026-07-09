/**
 * Typed REST client for the harness server (see the "REST API surface"
 * section of ../../../src/shared/types.ts). Gated at this layer: with
 * `VITE_MOCK=1` the whole app runs against in-memory fixtures and never
 * touches the network — this is what lets W2 build ahead of a running server.
 */
import type {
  AppState,
  BindWorkflowRequest,
  CreateSessionRequest,
  FsDirEntry,
  FsListResponse,
  HarnessSession,
  HarnessSettings,
  InjectInputRequest,
  MacroDef,
  RunMacroRequest,
  SampleProjectSeedResponse,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";

// Skill types (matched to the server-side SkillMeta/SkillDetail in
// src/server/skills.ts — kept here rather than in shared/types.ts since they
// are only consumed by the SPA, never by CLI or server logic).
export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  source: "package" | "user";
}
export interface SkillDetail extends SkillMeta {
  body: string;
}

/** Shape of a single entry returned by GET /api/harnesses. */
export interface HarnessEntry {
  id: string;
  label: string;
  mode: "embedded" | "external";
  experimental: boolean;
  installed: boolean;
  /** Per-harness MCP install instructions from the adapter registry. */
  installMcpPrompt: string;
}

import { MOCK_FS_TREE, MOCK_HARNESSES, MOCK_HISTORY, MOCK_LAUNCH_DIR, MOCK_MACROS, MOCK_SAMPLE_PROJECT_ROOT, MOCK_SESSIONS, MOCK_SETTINGS, MOCK_SKILLS, MOCK_SKILL_BODIES, MOCK_WORKFLOWS } from "./mock-data";

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

export interface HarnessApi {
  getState(): Promise<AppState>;
  createSession(req: CreateSessionRequest): Promise<HarnessSession>;
  listSessions(): Promise<HarnessSession[]>;
  sessionHistory(cwd: string): Promise<SessionSummary[]>;
  resumeSession(id: string): Promise<HarnessSession>;
  killSession(id: string): Promise<void>;
  injectInput(id: string, req: InjectInputRequest): Promise<void>;
  listWorkflows(): Promise<WorkflowInfo[]>;
  connectWorkflow(path: string): Promise<WorkflowInfo>;
  scanWorkflows(root: string): Promise<WorkflowInfo[]>;
  listMacros(): Promise<MacroDef[]>;
  runMacro(id: string, req: RunMacroRequest): Promise<void>;
  getSettings(): Promise<HarnessSettings>;
  updateSettings(patch: Partial<HarnessSettings>): Promise<HarnessSettings>;
  listDir(path?: string): Promise<FsListResponse>;
  bindWorkflow(sessionId: string, workflowPath: string | null): Promise<HarnessSession>;
  /** Seeds (or reuses) the bundled example project; the caller follows up
   *  with a normal createSession against the returned root. */
  seedSampleProject(): Promise<SampleProjectSeedResponse>;
  /** List all discoverable skills (package + user). */
  listSkills(): Promise<SkillMeta[]>;
  /** Fetch the full detail (including markdown body) for a single skill. */
  getSkill(id: string): Promise<SkillDetail>;
  /** List all harness adapters with their MCP install prompts. */
  listHarnesses(): Promise<HarnessEntry[]>;
}

class RealApi implements HarnessApi {
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

  listWorkflows(): Promise<WorkflowInfo[]> {
    return this.request<WorkflowInfo[]>("/api/workflows");
  }

  connectWorkflow(path: string): Promise<WorkflowInfo> {
    return this.request<WorkflowInfo>("/api/workflows/connect", { method: "POST", body: JSON.stringify({ path }) });
  }

  scanWorkflows(root: string): Promise<WorkflowInfo[]> {
    return this.request<WorkflowInfo[]>("/api/workflows/scan", { method: "POST", body: JSON.stringify({ root }) });
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

  listSkills(): Promise<SkillMeta[]> {
    return this.request<SkillMeta[]>("/api/skills");
  }

  getSkill(id: string): Promise<SkillDetail> {
    return this.request<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`);
  }

  listHarnesses(): Promise<HarnessEntry[]> {
    return this.request<HarnessEntry[]>("/api/harnesses");
  }
}

const delay = (ms = 180): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory, mutable copies of the fixtures — mutations persist for the tab's lifetime, reset on reload. */
class MockApi implements HarnessApi {
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
      // exercise the reactive 409 path in PromptBar (reason shown, draft intact).
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
      source: "connect",
    };
    this.workflows = [...this.workflows.filter((w) => w.path !== path), info];
    return info;
  }

  async scanWorkflows(_root: string): Promise<WorkflowInfo[]> {
    await delay(250);
    return this.workflows;
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

  async listSkills(): Promise<SkillMeta[]> {
    await delay(150);
    return MOCK_SKILLS;
  }

  async getSkill(id: string): Promise<SkillDetail> {
    await delay(100);
    const found = MOCK_SKILLS.find((s) => s.id === id);
    if (!found) throw new ApiError(404, `GET /api/skills/${id} → 404`, `Unknown skill '${id}'`);
    return { ...found, body: MOCK_SKILL_BODIES[id] ?? `# ${found.name}\n\n${found.description}` };
  }

  async listHarnesses(): Promise<HarnessEntry[]> {
    await delay(100);
    return MOCK_HARNESSES;
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
