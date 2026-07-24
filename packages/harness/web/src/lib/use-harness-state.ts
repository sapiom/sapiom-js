import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppState,
  BackgroundTask,
  BusMessage,
  RunView,
  CreateSessionRequest,
  HarnessSession,
  HarnessSettings,
  RunMacroRequest,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";

import type { HarnessEntry } from "@shared/types";

import {
  ApiError,
  boundWorkflowPathOf,
  createApi,
  getBootToken,
  type AuthStartResponse,
  type FsListResponse,
  type HarnessApi,
  type RunLocalLine,
} from "./api";
import { type ConnectivityErrorInput } from "./connectivity";
import { subscribeEvents } from "./events";
import { renderLocalRun } from "@shared/render-local-run";
import type { LocalStepTrace, LocalRunOutcome } from "@sapiom/agent-core";
import { saveLastDeploy } from "./deploy-meta";
import { isDefinitionNotFoundError, definitionNotFoundMessage } from "./definition-not-found";

const api = createApi();

/**
 * How long a session's tab stays "busy" after its last `session.activity`
 * ping — matches the "output in the last ~3s" busy-indicator spec. Longer
 * than the server's own broadcast throttle (2s) so a steadily-typing session
 * reads as continuously busy rather than flickering between pings.
 */
const BUSY_WINDOW_MS = 3_000;

/** Where a run executed — the server announces it on execution.started.
 *  "local" runs are stubbed (capabilities run against fixtures); "prod" runs
 *  are real cloud executions. */
export type RunTarget = "prod" | "local";

/** One observed run: the polled RunView plus the facts captured when its
 *  execution.started announcement arrived. */
export interface ObservedRun {
  run: RunView;
  target: RunTarget;
  /** The workflow bound to the run's session at announcement time, or null
   *  when nothing was bound. Captured ONCE: re-binding the session later
   *  must never re-attribute a past run's cost to the new workflow. */
  workflowPath: string | null;
  /** Client wall-clock (Date.now()) when execution.started was observed.
   *  RunView carries no server timestamps, so observation time is the only
   *  honest time the Studio can show for a run. */
  observedAt: number;
}

export interface HarnessStateHook {
  state: AppState | null;
  loading: boolean;
  error: string | null;
  /** The classifier-shaped facts about a failed boot fetch (HTTP status, or
   *  network-throw flag) — null when the boot succeeded. Lets the shell tell an
   *  offline boot from a rejected-credential boot from a generic failure and
   *  show the matching recoverable state instead of a dead error screen. */
  errorKind: ConnectivityErrorInput | null;
  /** Re-runs the one-shot boot fetch (AppState + settings). The recovery path
   *  for a failed boot: after regaining connectivity or once the server has
   *  refreshed the held key, this re-hydrates the shell in place — no reload,
   *  no lockout. Safe to call repeatedly; a success clears the error. */
  reload: () => void;
  settings: HarnessSettings | null;
  bootToken: string;
  selectedWorkflowPath: string | null;
  setSelectedWorkflowPath: (path: string | null) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  history: SessionSummary[];
  historyLoading: boolean;
  /** Loads past sessions across a set of directories (one global
   *  resume view, not one directory at a time). */
  loadHistory: (cwds: string[]) => Promise<void>;
  createSession: (req: CreateSessionRequest) => Promise<HarnessSession>;
  /** Welcome panel's "Run the sample project": seeds (or reuses) the bundled
   *  example, then opens a normal session in it with the default harness. */
  createSampleSession: () => Promise<HarnessSession>;
  resumeSession: (harnessSessionId: string) => Promise<HarnessSession>;
  resumeFromHistory: (summary: SessionSummary) => Promise<HarnessSession>;
  /** Dismisses an exited session (DELETE): drops it from the list and, if it was active, falls back to another running session or clears the pane. */
  closeSession: (id: string) => Promise<void>;
  connectWorkflow: (path: string) => Promise<WorkflowInfo>;
  /** Bulk discovery: POST /api/workflows/scan under a root, then
   *  refreshes the registry list so found agents join the rail at once. */
  scanWorkflows: (root: string) => Promise<WorkflowInfo[]>;
  /** Adapter registry (GET /api/harnesses) — drives the new-session picker
   *  (installed/experimental/external flags) and the MCP setup prompts. */
  listHarnesses: () => Promise<HarnessEntry[]>;
  /** Binds a workflow to a session ("what am I working on") — null unbinds. */
  bindWorkflow: (sessionId: string, workflowPath: string | null) => Promise<void>;
  updateSettings: (patch: Partial<HarnessSettings>) => Promise<HarnessSettings>;
  runMacro: (id: string, req: RunMacroRequest) => Promise<void>;
  /**
   * Deploy the agent linked to `workflowPath` via the DIRECT route (Deploy
   * button) — server-side, no Claude Code. Streams build status into the toast
   * slot; refreshes the registry on success so the Draft→Deployed chip flips.
   * Never rejects on a build failure (surfaced as a toast), matching runMacro's
   * fire-and-forget click contract.
   */
  deploy: (workflowPath: string) => Promise<void>;
  /**
   * Returns the error message from the last failed deploy for the given
   * workflow path, or `null` if the last deploy succeeded (or no deploy has
   * run for this path). Survives toast dismissal — the action bar uses this
   * to show "Last deploy failed — retry Deploy" rather than "Not deployed yet"
   * when a build has already been attempted and failed.
   */
  lastDeployErrorFor: (workflowPath: string) => string | null;
  /**
   * Monotonic counter bumped on every direct-action settle (deploy or run,
   * success or failure). SessionStepsBar adds this to its `useEffect` deps so
   * the pending ring clears on every settle — including re-deploys of an
   * already-deployed workflow where neither `deployed` nor `lastDeployError`
   * changes.
   */
  directActionSettleSeq: number;
  /**
   * Start a real prod execution via the DIRECT route (Prod-run button) — no
   * Claude Code — then hand the returned `executionId` to the run-inspector
   * poller so the run shows up in the Steps tab exactly as a CLI-launched run
   * does. Non-input errors go to the toast slot.
   *
   * `onInputError` — called with the failure message when the API rejects
   * because of a missing-input validation error. Used by the run-first flow
   * to decide whether to open the input dialog reactively.
   */
  startProdRun: (
    sessionId: string,
    definitionId: string,
    input?: unknown,
    onInputError?: (message: string) => void,
  ) => Promise<void>;
  /**
   * Runs the workflow at `sourceDir` OFFLINE against stub capabilities and
   * streams the result into the SAME run store the prod poller feeds — so the
   * click-into-step inspector renders a local stub run exactly as it renders a
   * prod run (per-step logs + pass/fail + IO), just `target: "local"` (free,
   * untimed). Resolves when the stream ends; a failed *run* is a normal
   * terminal state (surfaced in the run), not a rejection. Fully offline: no
   * key, no cost, works signed-out.
   *
   * `onInputError` — called with the failure message when the run fails because
   * of a missing-input validation error. Used by the run-first flow to decide
   * whether to open the input dialog reactively.
   */
  runLocal: (
    sessionId: string,
    sourceDir: string,
    input?: unknown,
    onInputError?: (message: string) => void,
  ) => Promise<void>;
  /**
   * Submits text to a session's pty via POST /api/sessions/:id/input.
   * Throws `ApiError` on HTTP errors — callers handle 409 (session not ready)
   * by showing the reason inline rather than as a toast.
   */
  injectInput: (sessionId: string, text: string) => Promise<void>;
  /** Expose the toast setter so panels can push their own toasts. */
  showToast: (message: string) => void;
  listDir: (path?: string) => Promise<FsListResponse>;
  lastMessage: BusMessage | null;
  /** The run each session's Steps tab is showing (the latest observed by
   *  default, or a past run picked via selectRun), with its target. */
  runsBySession: Map<string, ObservedRun>;
  /** EVERY run observed this Studio session, keyed by executionId. Entries
   *  are updated while a run polls but never dropped, so past runs stay
   *  inspectable. */
  runsByExecution: Map<string, ObservedRun>;
  /** Ordered executionIds observed per session (oldest first) — the run
   *  picker's source of truth. */
  runIdsBySession: Map<string, string[]>;
  /** Shows a past run in a session's Steps tab and refetches its state so
   *  the data is current even though its poller stopped long ago. */
  selectRun: (sessionId: string, executionId: string) => void;
  /** Detected dev-server preview per session (port.detected). */
  previewBySession: Map<string, { port: number; url: string }>;
  /** A user-facing message from the most recent failed action (e.g. a macro
   *  run against a not-yet-ready session) — null when there's nothing to
   *  show. `runMacro` never rejects on this kind of failure; it sets this
   *  instead, since its only caller today fires it without awaiting. */
  toast: string | null;
  dismissToast: () => void;
  /** Session ids with terminal output in roughly the last `BUSY_WINDOW_MS` —
   *  drives each session tab's busy pulse (see `session.activity` BusMessage). */
  busySessionIds: Set<string>;
  /** Background tasks (headless macro runs) — seeded from AppState.tasks,
   *  then kept fresh by `task.status` frames. Drives the canvas pane's
   *  activity/failure states. */
  tasks: BackgroundTask[];
  /** The underlying API client — exposed for consumers that need methods not
   *  surfaced as dedicated hook fns. */
  api: HarnessApi;
  /**
   * Kick off the browser OAuth sign-in flow (`POST /api/auth/start`). Returns
   * `{ started: true }` immediately; the sign-in completes asynchronously and
   * the state updates when the `auth.changed` bus message arrives. Throws on a
   * 409 (flow already in progress) or other HTTP errors.
   */
  startAuth(): Promise<AuthStartResponse>;
  /**
   * Sign out and clear stored credentials (`POST /api/auth/disconnect`).
   * Updates `AppState.authenticated`/`organizationName` via the `auth.changed`
   * bus message that the server broadcasts after disconnecting.
   */
  disconnect(): Promise<void>;
}

/** Central store for the SPA shell: fetches AppState + settings once, then keeps sessions/workflows fresh via the event bus. */
export function useHarnessState(): HarnessStateHook {
  const [state, setState] = useState<AppState | null>(null);
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Boot-error facts (HTTP status / network-throw flag), shaped for the
  // connectivity classifier so the shell can pick a recoverable offline vs
  // auth vs generic state instead of a dead "Failed to load" screen.
  const [errorKind, setErrorKind] = useState<ConnectivityErrorInput | null>(null);
  // Bumped by reload() to re-run the one-shot boot fetch (the recovery path).
  const [reloadSeq, setReloadSeq] = useState(0);
  const [selectedWorkflowPath, setSelectedWorkflowPath] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [lastMessage, setLastMessage] = useState<BusMessage | null>(null);
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const busyTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Runs (upstream runtime-analytics contract): an execution.started bus
  // message starts polling /api/runs/:id/state until the run is terminal.
  // Snapshots accumulate per executionId — never replaced by a later run —
  // so a new execution can't erase the one you were reading (or its costs).
  const [runsByExecution, setRunsByExecution] = useState<Map<string, ObservedRun>>(new Map());
  // Ordered executionIds observed per session, oldest first.
  const [runIdsBySession, setRunIdsBySession] = useState<Map<string, string[]>>(new Map());
  // Explicit run picks per session; absent = follow the latest run.
  const [pickedRunBySession, setPickedRunBySession] = useState<Map<string, string>>(new Map());
  const runPollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  // One-click preview loop: the server's PortDetector announces a
  // dev server the agent started; the session surfaces a Preview chip.
  const [previewBySession, setPreviewBySession] = useState<Map<string, { port: number; url: string }>>(new Map());
  // Per-workflow deploy error: set when a deploy stream ends with phase:"error",
  // cleared when a later deploy for that workflow succeeds. Keyed by workflow
  // path — survives toast dismissal so the disabled-reason in the action bar
  // stays accurate ("Last deploy failed — retry Deploy") instead of reverting
  // to "Not deployed yet" which would be misleading.
  const [lastDeployErrorByPath, setLastDeployErrorByPath] = useState<Map<string, string>>(new Map());
  // Monotonic settle counter for direct actions: bumped each time a deploy or
  // run (prod/local) reaches its terminal state — success OR failure. The
  // SessionStepsBar adds this to its useEffect deps so the pending ring clears
  // on EVERY settle, including re-deploys of an already-deployed workflow where
  // `deployed` stays true and `lastDeployError` stays null (so neither dep
  // flips on its own).
  const [directActionSettleSeq, setDirectActionSettleSeq] = useState(0);
  const bumpDirectActionSettleSeq = useCallback(() => {
    setDirectActionSettleSeq((n) => n + 1);
  }, []);

  // Monotonic count of explicit session switches. A resume that resolves
  // AFTER the user has already switched elsewhere must not yank them back —
  // the newer switch is the newer intent (observable via the palette: pick a
  // session while a resume is in flight and the resume would win the race).
  const switchSeqRef = useRef(0);
  const selectSession = useCallback((id: string | null): void => {
    switchSeqRef.current += 1;
    setActiveSessionId(id);
  }, []);

  // Mirror of state.sessions for bus-driven callbacks (startRunPolling) that
  // must read the CURRENT binding without re-subscribing on every state tick.
  const sessionsRef = useRef<HarnessSession[]>([]);

  // One-shot refresh of a run's stored snapshot (used by selectRun for past
  // runs whose poller is long gone). Only the RunView refreshes: target,
  // workflow attribution, and observation time were captured at start and
  // never change. Failures keep whatever was stored.
  const refreshRun = useCallback((executionId: string) => {
    api
      .getRunState(executionId)
      .then((run) =>
        setRunsByExecution((prev) => {
          const stored = prev.get(executionId);
          return stored ? new Map(prev).set(executionId, { ...stored, run }) : prev;
        }),
      )
      .catch(() => {});
  }, []);

  // Poll one run until terminal. A new run for the same session replaces the
  // old POLLER only — the previous run's snapshot stays in runsByExecution.
  const startRunPolling = useCallback((sessionId: string, executionId: string, target: RunTarget) => {
    const existing = runPollers.current.get(sessionId);
    if (existing) clearInterval(existing);
    // Attribution facts are captured NOW, not at read time: the workflow the
    // session is bound to when the run is announced owns the run's cost.
    // Attributing later through the current binding would lie whenever a
    // session re-binds mid-session.
    const workflowPath = boundWorkflowPathOf(sessionsRef.current.find((s) => s.id === sessionId));
    const observedAt = Date.now();
    setRunIdsBySession((prev) => {
      const ids = prev.get(sessionId) ?? [];
      if (ids.includes(executionId)) return prev;
      return new Map(prev).set(sessionId, [...ids, executionId]);
    });
    // A freshly started run takes the Steps tab over: drop any explicit pick
    // so the session follows its latest run again (the picker gets back to
    // any past run — nothing is lost, unlike the old overwrite model).
    setPickedRunBySession((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    const poll = async (): Promise<void> => {
      try {
        const run = await api.getRunState(executionId);
        setRunsByExecution((prev) => new Map(prev).set(executionId, { run, target, workflowPath, observedAt }));
        if (run.status !== "running") {
          const timer = runPollers.current.get(sessionId);
          if (timer) clearInterval(timer);
          runPollers.current.delete(sessionId);
        }
      } catch {
        // Endpoint absent (server predates runtime analytics) or transient
        // failure: stop polling quietly - the UI simply shows no run state.
        const timer = runPollers.current.get(sessionId);
        if (timer) clearInterval(timer);
        runPollers.current.delete(sessionId);
      }
    };
    void poll();
    runPollers.current.set(sessionId, setInterval(() => void poll(), 2000));
  }, []);

  // Monotonic counter for synthesizing local-run execution ids. A local run has
  // no server-issued id (it never touches the backend), so the store mints one;
  // it MUST contain "local" so every cost/target check that keys off the id
  // (e.g. the mock run-state convention) reads it as free.
  const localRunSeq = useRef(0);

  /**
   * Run an offline stub run and stream it into the shared run store. The NDJSON
   * arrives per-step: each {@link LocalStepTrace} line appends to a local buffer
   * that is re-mapped through `renderLocalRun` and written to `runsByExecution`,
   * so the inspector lights up step-by-step (same store, same shape, same
   * inspector as a prod run). The terminal `summary`/`error` line supplies the
   * run's final outcome; a run that could not be invoked becomes a single
   * failed step so the failure is still visible rather than silent.
   */
  const runLocal = useCallback(
    async (
      sessionId: string,
      sourceDir: string,
      input?: unknown,
      onInputError?: (message: string) => void,
    ): Promise<void> => {
      localRunSeq.current += 1;
      const executionId = `local-${Date.now()}-${localRunSeq.current}`;
      // Attribution + observation facts captured now, exactly like a prod run
      // (see startRunPolling) — a later re-bind must not re-attribute this run.
      const workflowPath = boundWorkflowPathOf(sessionsRef.current.find((s) => s.id === sessionId));
      const observedAt = Date.now();
      const traces: LocalStepTrace[] = [];
      let outcome: LocalRunOutcome | undefined;
      // Stub-hygiene signals from the terminal summary line (WB15-2). Held
      // alongside outcome so each re-map through renderLocalRun carries them;
      // absent until the summary lands, and renderLocalRun drops empties.
      let unusedStubs: Array<{ step: string; key: string }> | undefined;
      let stubWarnings: string[] | undefined;

      // Register the run so runsBySession surfaces it, and drop any explicit run
      // pick so the session follows this fresh run (mirrors startRunPolling).
      setRunIdsBySession((prev) => {
        const ids = prev.get(sessionId) ?? [];
        if (ids.includes(executionId)) return prev;
        return new Map(prev).set(sessionId, [...ids, executionId]);
      });
      setPickedRunBySession((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });

      const publish = (): void => {
        const run = renderLocalRun(traces, { executionId, outcome, unusedStubs, stubWarnings });
        setRunsByExecution((prev) =>
          new Map(prev).set(executionId, { run, target: "local", workflowPath, observedAt }),
        );
      };
      // Seed an empty running RunView up front so the Steps tab switches to this
      // run immediately, before the first trace line lands.
      publish();

      const onLine = (line: RunLocalLine): void => {
        if (line.kind === "summary") {
          outcome = line.outcome;
          // Carry the stub-hygiene signals so the inspector can surface a no-op
          // mock (unusedStubs) or a wrong-shape stub (stubWarnings). Passed
          // straight through; renderLocalRun applies the honest-absence rule.
          unusedStubs = line.unusedStubs;
          stubWarnings = line.stubWarnings;
        } else if (line.kind === "error") {
          // The run could not be invoked (bad project / stub file). Represent it
          // as a failed run carrying one failed step so the inspector shows the
          // reason instead of an empty, silently-failed run.
          outcome = "failed";
          traces.push({
            step: "run-local",
            attempt: 1,
            input,
            status: "threw",
            error: { name: "RunLocalError", message: line.error },
            logs: [],
          });
          // Notify the caller if this was a missing-input failure so it can open
          // the run-input dialog reactively.
          onInputError?.(line.error);
        } else {
          // A per-step trace line (no `kind`). Check for step-level input
          // validation failures (a step that threw because its input was invalid).
          if (line.status === "threw" && line.error?.message) {
            onInputError?.(line.error.message);
          }
          traces.push(line);
        }
        publish();
      };

      try {
        await api.runLocal({ sourceDir, input }, onLine);
      } catch (err) {
        // Transport failure (the stream itself broke) — mark the run failed so
        // it doesn't spin as "running" forever, and toast the reason.
        outcome = "failed";
        publish();
        setToast(err instanceof ApiError && err.reason ? err.reason : (err as Error).message);
      } finally {
        // Signal settle so the SessionStepsBar clears the Local Run button's
        // pending ring — the stream ended (success or failure), the button's
        // "in flight" state is over.
        bumpDirectActionSettleSeq();
      }
    },
    [bumpDirectActionSettleSeq],
  );

  const selectRun = useCallback(
    (sessionId: string, executionId: string) => {
      setPickedRunBySession((prev) => new Map(prev).set(sessionId, executionId));
      // Refetch so a past run shows current server truth, not a stale
      // mid-poll snapshot (refreshRun keeps the captured start facts).
      refreshRun(executionId);
    },
    [refreshRun],
  );

  // The run each session's Steps tab shows: the picked run when one is
  // chosen (and still known), else the latest observed.
  const runsBySession = useMemo(() => {
    const map = new Map<string, ObservedRun>();
    runIdsBySession.forEach((ids, sessionId) => {
      const picked = pickedRunBySession.get(sessionId);
      const id = picked && ids.includes(picked) ? picked : ids[ids.length - 1];
      const observed = id ? runsByExecution.get(id) : undefined;
      if (observed) map.set(sessionId, observed);
    });
    return map;
  }, [runIdsBySession, pickedRunBySession, runsByExecution]);

  // Keep the sessions mirror current for the next execution.started arrival.
  // An effect (not a render-phase write) so it never runs on a discarded
  // render; bus messages only arrive between commits anyway.
  useEffect(() => {
    sessionsRef.current = state?.sessions ?? [];
  }, [state]);

  useEffect(() => {
    const pollers = runPollers.current;
    return () => {
      pollers.forEach((timer) => clearInterval(timer));
      pollers.clear();
    };
  }, []);

  // Timers are keyed per-session and outlive individual renders — clear them
  // all on unmount so a pending "clear busy" timeout never fires against a
  // torn-down component.
  useEffect(() => {
    const timers = busyTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A retry re-enters the loading state and clears the prior failure so the
    // shell shows "reconnecting", not a stale error, while the refetch runs.
    if (reloadSeq > 0) {
      setLoading(true);
      setError(null);
      setErrorKind(null);
    }
    Promise.all([api.getState(), api.getSettings()])
      .then(([appState, harnessSettings]) => {
        if (cancelled) return;
        setState(appState);
        setSettings(harnessSettings);
        setErrorKind(null);
        if (appState.tasks) setTasks(appState.tasks);
        const running = appState.sessions.find((session) => session.status !== "exited");
        if (running) setActiveSessionId(running.id);
        if (appState.workflows[0]) setSelectedWorkflowPath(appState.workflows[0].path);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError((err as Error).message);
        // An ApiError reached the server (401/403 = recoverable auth, 5xx =
        // generic); anything else is a network-level throw the browser raises
        // when it never got a response (offline / unreachable) — recorded as
        // such so the classifier picks the offline state, not a dead end.
        setErrorKind(err instanceof ApiError ? { status: err.status } : { networkError: true });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [reloadSeq]);

  // Recovery path for a failed boot: re-run the one-shot fetch. Bumping the
  // seq re-fires the boot effect above (which resets loading/error itself).
  const reload = useCallback(() => setReloadSeq((n) => n + 1), []);

  // Switching sessions follows that session's own binding, INCLUDING clearing
  // the highlight when the new session has nothing bound — the rail must
  // never show a workflow tinted for a session it isn't actually bound to.
  useEffect(() => {
    if (!activeSessionId) return;
    const session = state?.sessions.find((s) => s.id === activeSessionId);
    setSelectedWorkflowPath(boundWorkflowPathOf(session) ?? null);
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
        // An exited session can never produce more output — drop any pending
        // busy state/timer for it rather than leaving a stale pulse on a tab
        // that's about to move to the history menu.
        if (message.session.status === "exited") {
          const id = message.session.id;
          const timer = busyTimers.current.get(id);
          if (timer) {
            clearTimeout(timer);
            busyTimers.current.delete(id);
          }
          setBusySessionIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      } else if (message.type === "workflows.changed") {
        void refreshWorkflows();
      } else if (message.type === "execution.started") {
        startRunPolling(message.harnessSessionId, message.executionId, message.target);
      } else if (message.type === "port.detected") {
        setPreviewBySession((prev) =>
          new Map(prev).set(message.harnessSessionId, { port: message.port, url: message.url }),
        );
      } else if (message.type === "task.status") {
        // Each frame is a full snapshot of one task — upsert by id.
        setTasks((prev) => {
          const exists = prev.some((task) => task.id === message.task.id);
          return exists
            ? prev.map((task) => (task.id === message.task.id ? message.task : task))
            : [...prev, message.task];
        });
      } else if (message.type === "session.activity") {
        const id = message.harnessSessionId;
        setBusySessionIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        const existingTimer = busyTimers.current.get(id);
        if (existingTimer) clearTimeout(existingTimer);
        busyTimers.current.set(
          id,
          setTimeout(() => {
            busyTimers.current.delete(id);
            setBusySessionIds((prev) => {
              if (!prev.has(id)) return prev;
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }, BUSY_WINDOW_MS),
        );
      } else if (message.type === "auth.changed") {
        // Real-time auth state update from the server — update AppState in
        // place so SettingsPopover, WorkflowsRail, and deploy gating all
        // react without a full reload or polling.
        setState((prev) =>
          prev
            ? {
                ...prev,
                authenticated: message.authenticated,
                organizationName: message.organizationName,
              }
            : prev,
        );
      }
    });
  }, [refreshWorkflows, startRunPolling]);

  const loadHistory = useCallback(async (cwds: string[]) => {
    setHistoryLoading(true);
    try {
      // Fan out per directory; one failing dir never hides the others'
      // history. Dedupe by agentSessionId (a dir can repeat across sources)
      // and sort newest first — the menu renders one flat, global list.
      const results = await Promise.allSettled(cwds.map((cwd) => api.sessionHistory(cwd)));
      const byAgentId = new Map<string, SessionSummary>();
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const summary of result.value) {
          if (!byAgentId.has(summary.agentSessionId)) byAgentId.set(summary.agentSessionId, summary);
        }
      }
      setHistory(
        Array.from(byAgentId.values()).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const createSession = useCallback(async (req: CreateSessionRequest): Promise<HarnessSession> => {
    const session = await api.createSession(req);
    // The event bus can deliver this session's first `session.status` before
    // the POST response resolves (the server broadcasts starting/running
    // during create) — appending unconditionally then renders a duplicate
    // tab. When it's already in the list, the bus copy is also the fresher
    // one, so keep it rather than overwrite with this response's snapshot.
    setState((prev) =>
      prev && !prev.sessions.some((s) => s.id === session.id)
        ? { ...prev, sessions: [...prev.sessions, session] }
        : prev,
    );
    selectSession(session.id);

    let optimisticRecentDirs: string[] = [];
    setSettings((prev) => {
      optimisticRecentDirs = [req.cwd, ...(prev?.recentDirs ?? []).filter((dir) => dir !== req.cwd)].slice(0, 8);
      return prev ? { ...prev, recentDirs: optimisticRecentDirs } : prev;
    });
    // The server is the source of truth for what actually qualifies as a
    // recent dir (must resolve to a real, existing directory) — replace the
    // optimistic guess with its sanitized response so invalid input (e.g.
    // stray free text typed into the directory field) never lingers in the UI.
    try {
      const updated = await api.updateSettings({ recentDirs: optimisticRecentDirs });
      setSettings((prev) => (prev ? { ...prev, recentDirs: updated.recentDirs } : prev));
    } catch {
      // Non-fatal — session creation itself already succeeded.
    }
    return session;
  }, [selectSession]);

  const createSampleSession = useCallback(async (): Promise<HarnessSession> => {
    const seeded = await api.seedSampleProject();
    // Same default-harness choice the auto-created boot session uses:
    // doctor()'s preference order, falling back to claude-code when the
    // server didn't report availability (see AppState.availableHarnesses).
    const harness = state?.availableHarnesses?.[0] ?? "claude-code";
    return createSession({ cwd: seeded.root, harness });
  }, [state?.availableHarnesses, createSession]);

  const resumeSession = useCallback(
    async (harnessSessionId: string): Promise<HarnessSession> => {
      const seqAtStart = switchSeqRef.current;
      try {
        const session = await api.resumeSession(harnessSessionId);
        setState((prev) =>
          prev ? { ...prev, sessions: prev.sessions.map((s) => (s.id === session.id ? session : s)) } : prev,
        );
        // Only claim focus if the user hasn't explicitly switched sessions
        // while the resume was in flight — their pick outranks this resolve.
        if (switchSeqRef.current === seqAtStart) selectSession(session.id);
        return session;
      } catch (err) {
        // Surface resume failures as a toast so a failed resume is never silent
        // (the caller fires this with void and swallows the rejection).
        setToast(err instanceof ApiError && err.reason ? err.reason : (err as Error).message);
        throw err;
      }
    },
    [selectSession],
  );

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
      try {
        await api.killSession(id);
      } catch (err) {
        // Surface the failure as a toast and keep the user on the dead-session
        // overlay: the re-throw below skips the local removal, so a failed kill
        // never makes the session vanish from the UI as if it had succeeded.
        setToast(err instanceof ApiError && err.reason ? err.reason : (err as Error).message);
        throw err;
      }
      const remaining = (state?.sessions ?? []).filter((session) => session.id !== id);
      setState((prev) => (prev ? { ...prev, sessions: remaining } : prev));
      if (activeSessionId === id) {
        const nextRunning = remaining.find((session) => session.status !== "exited");
        selectSession(nextRunning ? nextRunning.id : null);
      }
    },
    [state, activeSessionId, selectSession],
  );

  const connectWorkflow = useCallback(async (path: string): Promise<WorkflowInfo> => {
    const workflow = await api.connectWorkflow(path);
    setState((prev) =>
      prev ? { ...prev, workflows: [...prev.workflows.filter((w) => w.path !== workflow.path), workflow] } : prev,
    );
    return workflow;
  }, []);

  const scanWorkflows = useCallback(
    async (root: string): Promise<WorkflowInfo[]> => {
      const found = await api.scanWorkflows(root);
      // The scan registers server-side; re-list so every discovered agent
      // joins the rail in one shot instead of trickling in per connect.
      await refreshWorkflows();
      return found;
    },
    [refreshWorkflows],
  );

  const listHarnesses = useCallback((): Promise<HarnessEntry[]> => api.listHarnesses(), []);

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

  // Deploy via the direct route: stream build status to the toast, then refresh
  // the registry so a linked/rebuilt workflow's Deployed chip flips. Swallows
  // failures into the toast (like runMacro) — its caller fires it unawaited.
  const deploy = useCallback(
    async (workflowPath: string): Promise<void> => {
      setToast("Deploying — building on Sapiom…");
      try {
        const terminal = await api.deploy(workflowPath, (event) => {
          if (event.phase === "building") setToast("Deploying — building on Sapiom…");
        });
        if (terminal.phase === "ready") {
          setToast("Deployed to Sapiom.");
          // Persist the deploy result so the deployment popover can surface the
          // build id and relative timestamp without a network call.
          saveLastDeploy(workflowPath, {
            buildRunId: terminal.buildRunId,
            deployedAt: Date.now(),
          });
          // Clear any prior deploy error for this workflow — it succeeded.
          setLastDeployErrorByPath((prev) => {
            if (!prev.has(workflowPath)) return prev;
            const next = new Map(prev);
            next.delete(workflowPath);
            return next;
          });
          // A successful deploy links/rebuilds the agent — re-read the registry
          // so definitionId (the Draft→Deployed truth) and the deploy-gated
          // actions update without waiting on a bus refresh.
          await refreshWorkflows();
        } else if (terminal.phase === "error") {
          const rawMsg = terminal.hint
            ? `Deploy failed: ${terminal.message} (${terminal.hint})`
            : `Deploy failed: ${terminal.message}`;
          // Replace a raw "definition not found" error with an actionable prompt
          // so users who cloned a gallery template know what to do.
          const msg = isDefinitionNotFoundError(terminal.message)
            ? definitionNotFoundMessage()
            : rawMsg;
          setToast(msg);
          // Persist the failure so the action bar can distinguish "last deploy
          // failed" from "never deployed" after the toast is dismissed.
          setLastDeployErrorByPath((prev) => new Map(prev).set(workflowPath, msg));
        }
      } catch (err) {
        const raw = err instanceof ApiError && err.reason ? err.reason : (err as Error).message;
        // Replace a raw "definition not found" error with an actionable prompt.
        const msg = isDefinitionNotFoundError(raw)
          ? definitionNotFoundMessage()
          : raw;
        setToast(msg);
        // An exception from the deploy stream (e.g. network error) also counts
        // as a deploy failure — persist so the action bar reflects it.
        setLastDeployErrorByPath((prev) => new Map(prev).set(workflowPath, msg));
      } finally {
        // Signal that a deploy action settled (success or failure) so the
        // SessionStepsBar can clear its pending ring for this button.
        bumpDirectActionSettleSeq();
      }
    },
    [refreshWorkflows, bumpDirectActionSettleSeq],
  );

  // Prod-run via the direct route: start the execution server-side, then feed
  // the returned executionId into the SAME poller a CLI-launched run uses
  // (startRunPolling) so it lands in the Steps tab / run picker identically.
  const startProdRun = useCallback(
    async (
      sessionId: string,
      definitionId: string,
      input?: unknown,
      onInputError?: (message: string) => void,
    ): Promise<void> => {
      try {
        const { executionId } = await api.run({ definitionId, input });
        startRunPolling(sessionId, executionId, "prod");
      } catch (err) {
        const raw = err instanceof ApiError && err.reason ? err.reason : (err as Error).message;
        // Replace a raw "definition not found" message with an actionable prompt
        // so users who cloned a gallery template know to deploy rather than
        // hitting a dead-end error about an id that isn't on their account.
        const msg = isDefinitionNotFoundError(raw)
          ? definitionNotFoundMessage(definitionId)
          : raw;
        // Notify the caller before toasting so it can decide whether to open
        // the run-input dialog instead of showing a bare error toast.
        onInputError?.(msg);
        setToast(msg);
      } finally {
        // Signal settle so the SessionStepsBar clears its pending ring for
        // the Prod Run button — the run has been handed off to the poller
        // (or failed), either way the "in flight" state for the button is done.
        bumpDirectActionSettleSeq();
      }
    },
    [startRunPolling, bumpDirectActionSettleSeq],
  );

  const startAuth = useCallback(async (): Promise<AuthStartResponse> => {
    return api.startAuth();
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    try {
      await api.disconnect();
    } catch (err) {
      setToast(err instanceof ApiError && err.reason ? err.reason : (err as Error).message);
    }
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  // Unlike runMacro (which swallows errors into a toast), injectInput lets the
  // error propagate so callers can handle 409 "not ready" inline without a
  // generic toast message.
  const injectInput = useCallback(async (sessionId: string, text: string): Promise<void> => {
    await api.injectInput(sessionId, { text, submit: true });
  }, []);

  const showToast = useCallback((message: string): void => {
    setToast(message);
  }, []);

  const lastDeployErrorFor = useCallback(
    (workflowPath: string): string | null => lastDeployErrorByPath.get(workflowPath) ?? null,
    [lastDeployErrorByPath],
  );

  const listDir = useCallback((path?: string): Promise<FsListResponse> => api.listDir(path), []);

  return {
    state,
    loading,
    error,
    errorKind,
    reload,
    settings,
    bootToken: getBootToken(),
    selectedWorkflowPath,
    setSelectedWorkflowPath,
    activeSessionId,
    // Exposed as the ONE way to switch sessions — routes through
    // selectSession so explicit switches always outrank in-flight resumes.
    setActiveSessionId: selectSession,
    history,
    historyLoading,
    loadHistory,
    createSession,
    createSampleSession,
    resumeSession,
    resumeFromHistory,
    closeSession,
    connectWorkflow,
    scanWorkflows,
    listHarnesses,
    bindWorkflow,
    updateSettings,
    runMacro,
    deploy,
    startProdRun,
    runLocal,
    injectInput,
    showToast,
    lastDeployErrorFor,
    directActionSettleSeq,
    listDir,
    lastMessage,
    runsBySession,
    runsByExecution,
    runIdsBySession,
    selectRun,
    previewBySession,
    toast,
    dismissToast,
    busySessionIds,
    tasks,
    api,
    startAuth,
    disconnect,
  };
}
