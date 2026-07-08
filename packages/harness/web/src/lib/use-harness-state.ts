import { useCallback, useEffect, useState } from "react";
import type {
  AppState,
  BusMessage,
  CreateSessionRequest,
  HarnessSession,
  HarnessSettings,
  RunMacroRequest,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";

import { ApiError, boundWorkflowPathOf, createApi, getBootToken, type FsListResponse } from "./api";
import { subscribeEvents } from "./events";

const api = createApi();

export interface HarnessStateHook {
  state: AppState | null;
  loading: boolean;
  error: string | null;
  settings: HarnessSettings | null;
  bootToken: string;
  selectedWorkflowPath: string | null;
  setSelectedWorkflowPath: (path: string | null) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  history: SessionSummary[];
  historyLoading: boolean;
  loadHistory: (cwd: string) => Promise<void>;
  createSession: (req: CreateSessionRequest) => Promise<HarnessSession>;
  resumeSession: (harnessSessionId: string) => Promise<HarnessSession>;
  resumeFromHistory: (summary: SessionSummary) => Promise<HarnessSession>;
  /** Dismisses an exited session (DELETE): drops it from the list and, if it was active, falls back to another running session or clears the pane. */
  closeSession: (id: string) => Promise<void>;
  connectWorkflow: (path: string) => Promise<WorkflowInfo>;
  /** Binds a workflow to a session ("what am I working on") — null unbinds. */
  bindWorkflow: (sessionId: string, workflowPath: string | null) => Promise<void>;
  updateSettings: (patch: Partial<HarnessSettings>) => Promise<HarnessSettings>;
  runMacro: (id: string, req: RunMacroRequest) => Promise<void>;
  listDir: (path?: string) => Promise<FsListResponse>;
  lastMessage: BusMessage | null;
  /** A user-facing message from the most recent failed action (e.g. a macro
   *  run against a not-yet-ready session) — null when there's nothing to
   *  show. `runMacro` never rejects on this kind of failure; it sets this
   *  instead, since its only caller today fires it without awaiting. */
  toast: string | null;
  dismissToast: () => void;
}

/** Central store for the SPA shell: fetches AppState + settings once, then keeps sessions/workflows fresh via the event bus. */
export function useHarnessState(): HarnessStateHook {
  const [state, setState] = useState<AppState | null>(null);
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflowPath, setSelectedWorkflowPath] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [lastMessage, setLastMessage] = useState<BusMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getState(), api.getSettings()])
      .then(([appState, harnessSettings]) => {
        if (cancelled) return;
        setState(appState);
        setSettings(harnessSettings);
        const running = appState.sessions.find((session) => session.status !== "exited");
        if (running) setActiveSessionId(running.id);
        if (appState.workflows[0]) setSelectedWorkflowPath(appState.workflows[0].path);
      })
      .catch((err: unknown) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Switching sessions follows that session's own binding (if any) rather than
  // leaving the rail highlighted on whatever the previous session had selected.
  useEffect(() => {
    if (!activeSessionId) return;
    const session = state?.sessions.find((s) => s.id === activeSessionId);
    const bound = boundWorkflowPathOf(session);
    if (bound) setSelectedWorkflowPath(bound);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const refreshWorkflows = useCallback(async () => {
    const workflows = await api.listWorkflows();
    setState((prev) => (prev ? { ...prev, workflows } : prev));
  }, []);

  useEffect(() => {
    return subscribeEvents((message) => {
      setLastMessage(message);
      if (message.type === "session.status") {
        setState((prev) => {
          if (!prev) return prev;
          const exists = prev.sessions.some((session) => session.id === message.session.id);
          const sessions = exists
            ? prev.sessions.map((session) => (session.id === message.session.id ? message.session : session))
            : [...prev.sessions, message.session];
          return { ...prev, sessions };
        });
      } else if (message.type === "workflows.changed") {
        void refreshWorkflows();
      }
    });
  }, [refreshWorkflows]);

  const loadHistory = useCallback(async (cwd: string) => {
    setHistoryLoading(true);
    try {
      setHistory(await api.sessionHistory(cwd));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const createSession = useCallback(async (req: CreateSessionRequest): Promise<HarnessSession> => {
    const session = await api.createSession(req);
    setState((prev) => (prev ? { ...prev, sessions: [...prev.sessions, session] } : prev));
    setActiveSessionId(session.id);
    setSettings((prev) => {
      const recentDirs = [req.cwd, ...(prev?.recentDirs ?? []).filter((dir) => dir !== req.cwd)].slice(0, 10);
      void api.updateSettings({ recentDirs });
      return prev ? { ...prev, recentDirs } : prev;
    });
    return session;
  }, []);

  const resumeSession = useCallback(async (harnessSessionId: string): Promise<HarnessSession> => {
    const session = await api.resumeSession(harnessSessionId);
    setState((prev) =>
      prev ? { ...prev, sessions: prev.sessions.map((s) => (s.id === session.id ? session : s)) } : prev,
    );
    setActiveSessionId(session.id);
    return session;
  }, []);

  /**
   * Resumes a history entry. Prefers the registry's own harnessSessionId back-reference;
   * falls back to matching agentSessionId against live sessions for older/partial data,
   * and — for transcript-sourced entries the harness never tracked at all — starts a
   * fresh session in the same directory rather than blocking on a resume path that
   * doesn't exist for them.
   */
  const resumeFromHistory = useCallback(
    async (summary: SessionSummary): Promise<HarnessSession> => {
      const harnessSessionId =
        summary.harnessSessionId ??
        state?.sessions.find((session) => session.agentSessionId === summary.agentSessionId)?.id;
      if (harnessSessionId) return resumeSession(harnessSessionId);
      return createSession({ cwd: summary.cwd, harness: summary.harness });
    },
    [state, resumeSession, createSession],
  );

  const closeSession = useCallback(
    async (id: string): Promise<void> => {
      await api.killSession(id);
      const remaining = (state?.sessions ?? []).filter((session) => session.id !== id);
      setState((prev) => (prev ? { ...prev, sessions: remaining } : prev));
      if (activeSessionId === id) {
        const nextRunning = remaining.find((session) => session.status !== "exited");
        setActiveSessionId(nextRunning ? nextRunning.id : null);
      }
    },
    [state, activeSessionId],
  );

  const connectWorkflow = useCallback(async (path: string): Promise<WorkflowInfo> => {
    const workflow = await api.connectWorkflow(path);
    setState((prev) =>
      prev ? { ...prev, workflows: [...prev.workflows.filter((w) => w.path !== workflow.path), workflow] } : prev,
    );
    return workflow;
  }, []);

  const bindWorkflow = useCallback(async (sessionId: string, workflowPath: string | null): Promise<void> => {
    const session = await api.bindWorkflow(sessionId, workflowPath);
    setState((prev) =>
      prev ? { ...prev, sessions: prev.sessions.map((s) => (s.id === session.id ? session : s)) } : prev,
    );
  }, []);

  const updateSettings = useCallback(async (patch: Partial<HarnessSettings>): Promise<HarnessSettings> => {
    const updated = await api.updateSettings(patch);
    setSettings(updated);
    if (patch.telemetryOptIn !== undefined) {
      setState((prev) => (prev ? { ...prev, telemetryOptIn: updated.telemetryOptIn } : prev));
    }
    return updated;
  }, []);

  const runMacro = useCallback(async (id: string, req: RunMacroRequest): Promise<void> => {
    try {
      await api.runMacro(id, req);
    } catch (err) {
      // App.tsx fires this without awaiting — surface failures as a toast
      // instead of an invisible unhandled rejection (which is exactly how
      // the trust-dialog race originally went unnoticed: the macro's input
      // vanished and nothing told the user why).
      setToast(err instanceof ApiError && err.reason ? err.reason : (err as Error).message);
    }
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const listDir = useCallback((path?: string): Promise<FsListResponse> => api.listDir(path), []);

  return {
    state,
    loading,
    error,
    settings,
    bootToken: getBootToken(),
    selectedWorkflowPath,
    setSelectedWorkflowPath,
    activeSessionId,
    setActiveSessionId,
    history,
    historyLoading,
    loadHistory,
    createSession,
    resumeSession,
    resumeFromHistory,
    closeSession,
    connectWorkflow,
    bindWorkflow,
    updateSettings,
    runMacro,
    listDir,
    lastMessage,
    toast,
    dismissToast,
  };
}
