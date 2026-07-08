/**
 * Typed REST client for the harness server (see the "REST API surface"
 * section of ../../../src/shared/types.ts). Gated at this layer: with
 * `VITE_MOCK=1` the whole app runs against in-memory fixtures and never
 * touches the network — this is what lets W2 build ahead of a running server.
 */
import type {
  AppState,
  CreateSessionRequest,
  HarnessSession,
  HarnessSettings,
  InjectInputRequest,
  MacroDef,
  RunMacroRequest,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";

import { MOCK_FS_TREE, MOCK_HISTORY, MOCK_LAUNCH_DIR, MOCK_MACROS, MOCK_SESSIONS, MOCK_SETTINGS, MOCK_WORKFLOWS } from "./mock-data";

export function isMockMode(): boolean {
  return import.meta.env.VITE_MOCK === "1";
}

/** Read once at module load: `window.__HARNESS__ = {token}` (baked in by the server), falling back to `?token=`. */
export function getBootToken(): string {
  const injected = (window as unknown as { __HARNESS__?: { token?: string } }).__HARNESS__;
  if (injected?.token) return injected.token;
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

/**
 * GET /api/fs/list?path= response shape (directory autocomplete for the
 * new-session picker). Mirrors src/server/fs.ts's own local types — not yet
 * folded into the shared contract, so duplicated here rather than importing
 * across the client/server boundary. `parent` is always a real path, never
 * null: at the filesystem root it equals `path` itself (matches
 * `path.dirname("/") === "/"`), so "no further up" is `parent === path`.
 */
export interface FsDirEntry {
  name: string;
  path: string;
}

export interface FsListResponse {
  path: string;
  parent: string;
  dirs: FsDirEntry[];
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
      throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}${body ? `: ${body}` : ""}`);
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
}

const delay = (ms = 180): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory, mutable copies of the fixtures — mutations persist for the tab's lifetime, reset on reload. */
class MockApi implements HarnessApi {
  private sessions = MOCK_SESSIONS.map((session) => ({ ...session }));
  private workflows = MOCK_WORKFLOWS.map((workflow) => ({ ...workflow }));
  private settings: HarnessSettings = { ...MOCK_SETTINGS, recentDirs: [...MOCK_SETTINGS.recentDirs] };

  async getState(): Promise<AppState> {
    await delay();
    return {
      version: "0.0.1-mock",
      authenticated: true,
      userId: "user_mock",
      organizationName: "Acme (mock)",
      telemetryOptIn: this.settings.telemetryOptIn,
      sessions: this.sessions,
      workflows: this.workflows,
      macros: MOCK_MACROS,
      launchDir: MOCK_LAUNCH_DIR,
    };
  }

  async createSession(req: CreateSessionRequest): Promise<HarnessSession> {
    await delay(300);
    const session: HarnessSession = {
      id: `sess-mock-${this.sessions.length + 1}`,
      agentSessionId: null,
      harness: req.harness,
      cwd: req.cwd,
      title: req.cwd.split("/").filter(Boolean).pop() ?? req.cwd,
      status: "starting",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
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

  async injectInput(_id: string, _req: InjectInputRequest): Promise<void> {
    await delay();
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

  async runMacro(_id: string, _req: RunMacroRequest): Promise<void> {
    await delay(200);
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
}

export function createApi(): HarnessApi {
  return isMockMode() ? new MockApi() : new RealApi();
}
