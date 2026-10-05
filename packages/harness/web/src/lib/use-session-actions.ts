/**
 * Every door that creates, selects, ends or hides a session, and the session
 * state the rail and the workbench read (hidden rows, renames, Start chat's
 * pending binds, the setup disclosure, held first prompts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type {
  CreateSessionRequest,
  HarnessEntry,
  HarnessKind,
  HarnessSession,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";

import { errorMessage } from "./api";
import type { CentreView } from "./centre-pane";
import { deriveAgentName, planningInstructions } from "./creation-entry";
import {
  DEFAULT_HARNESS,
  isHarnessSelectable,
  orderHarnesses,
} from "./harness-registry";
import type { NewSessionAttachment } from "./new-session-attachments";
import { samePath } from "./paths";
import type { ShellProjects } from "./shell-projects";
import { track } from "./track";
import { track as trackProduct } from "./analytics/events";
import { loadUiPrefs, saveUiPrefs } from "./ui-prefs";
import type { HarnessStateHook } from "./use-harness-state";
import type { Dialogs } from "./use-dialogs";

/**
 * How long a held initial prompt waits for the coding agent to become ready
 * (i.e. the user to finish any sign-in, trust, or onboarding step) before we
 * give up and surface the failure. The normal end of a hold is the session
 * going ready (prompt sent) or exiting — this is only a leak-guard for setup
 * the user walks away from.
 */
const HELD_PROMPT_TIMEOUT_MS = 10 * 60_000;

/**
 * Grace before nudging the user toward the terminal. A ready agent reports
 * within a beat, so its held prompt sends before this fires and no hint shows;
 * only a session still stuck on sign-in, trust, or onboarding survives the
 * grace and surfaces the hint.
 */
const HELD_PROMPT_HINT_DELAY_MS = 4_000;

/** What the centre is pointed at, and the doors every navigation shares. */
export interface ShellNav {
  view: CentreView;
  setView: Dispatch<SetStateAction<CentreView>>;
  /**
   * Bumped by every navigation. An async door (an empty project's map read,
   * a project being opened) compares against it before landing, so a click
   * made while it was pending is never overridden by a late answer.
   */
  navGenerationRef: MutableRefObject<number>;
  setMapPanelPath: Dispatch<SetStateAction<string | null>>;
  closeMobileDrawer: () => void;
}

export interface CreateSessionAtOptions {
  initialPrompt?: CreateSessionRequest["initialPrompt"];
  initialAttachments?: CreateSessionRequest["initialAttachments"];
  initialSources?: CreateSessionRequest["initialSources"];
  initialSetup?: CreateSessionRequest["initialSetup"];
  /** Keep the new-agent screen mounted while inline files are materialized. */
  keepComposerOpen?: boolean;
  /** The caller already owns the session's first real user-authored turn. */
  initialUserInputPending?: boolean;
  /**
   * False when the caller binds the session before anyone sees it (Start chat,
   * design.md I6): the centre stays where it is and the session is selected
   * only once its binding lands. Default true: the new session is the centre.
   */
  select?: boolean;
  /** Runs as soon as the POST names the exact session. */
  onCreated?: (session: HarnessSession) => void;
}

export const useSessionActions = ({
  harness,
  projects,
  dialogs,
  nav,
}: {
  harness: HarnessStateHook;
  projects: ShellProjects | null;
  dialogs: Dialogs;
  nav: ShellNav;
}) => {
  const state = harness.state;
  const { navGenerationRef, setView, setMapPanelPath, closeMobileDrawer } = nav;
  const {
    composerProject,
    setComposing,
    setComposerProject,
    setReviewSummary,
    setTemplatesOpen,
    setOverviewOpen,
    leaveDestinations,
  } = dialogs;
  const [selectedHarness, setSelectedHarness] = useState<HarnessKind>(
    () => loadUiPrefs().preferredHarness ?? DEFAULT_HARNESS,
  );
  const [harnessEntries, setHarnessEntries] = useState<HarnessEntry[] | null>(
    null,
  );
  // Keep the selection above the composer so every template entry point sees
  // automatic corrections and choices that could not be saved to preferences.
  useEffect(() => {
    let cancelled = false;
    harness
      .listHarnesses()
      .then((registry) => {
        if (cancelled || registry.length === 0) return;
        setHarnessEntries(orderHarnesses(registry));
        const selectable = registry.filter(isHarnessSelectable);
        setSelectedHarness((current) =>
          selectable.some((entry) => entry.id === current)
            ? current
            : ((selectable[0]?.id as HarnessKind | undefined) ?? current),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [harness.listHarnesses]);
  useEffect(() => {
    saveUiPrefs({ preferredHarness: selectedHarness });
  }, [selectedHarness]);
  /**
   * The planning instructions each new agent's first session was set up with
   * (flow-creation.md §4.4 step 3): shown as a quiet setup disclosure above
   * the terminal, never as the user's words. Held for this page's lifetime;
   * the pty already received the text, so nothing is lost on reload except
   * the disclosure itself.
   */
  const [setupBySession, setSetupBySession] = useState<Map<string, string>>(
    () => new Map(),
  );
  /** An agent the screen created whose first session failed to start; the
   *  next submit of the same idea in the same project reuses it. */
  const scaffoldedButUnstartedRef = useRef<{
    root: string;
    name: string;
    path: string;
  } | null>(null);
  /** Exited sessions hidden from the rail with `×` (flow Q4); History keeps
   *  them. Persisted beside the session renames. */
  const [hiddenSessionIds, setHiddenSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(loadUiPrefs().hiddenSessionIds ?? []),
  );
  /**
   * Sessions a Start chat created and has not bound yet. The rail leaves them
   * out until the binding lands, so a chat started FROM an agent never shows,
   * even for a frame, as an unbound session (design.md I6: `POST /sessions`
   * takes no agent, so create and bind are two requests).
   */
  const [pendingBindIds, setPendingBindIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Start chat is a one-at-a-time create/bind transaction. State renders the
  // pending button; the ref closes React's same-frame double-click window.
  const [startChatPending, setStartChatPending] = useState(false);
  const startChatPendingRef = useRef(false);
  // User session renames (no server rename endpoint yet, so names persist
  // client-side with the rest of the UI arrangement). State
  // here so the rail and the header re-render together on a rename.
  const [sessionNames, setSessionNames] = useState<Record<string, string>>(
    () => loadUiPrefs().sessionNames ?? {},
  );
  const renameSession = (id: string, name: string): void => {
    setSessionNames((prev) => {
      const next = { ...prev };
      const trimmed = name.trim();
      if (trimmed) next[id] = trimmed;
      else delete next[id];
      saveUiPrefs({ sessionNames: next });
      return next;
    });
  };

  // Session-then-prompt flows (scaffold, templates, clone) must NOT fire the
  // first prompt while the coding agent is still on its own login/onboarding
  // screen. Claude Code only becomes injectable once its SessionStart hook
  // sets session.ready — and that hook does not fire until the user is signed
  // in. So we HOLD the prompt keyed by session id and send it the moment the
  // session reports ready, rather than racing a fixed retry window that expires
  // mid-onboarding and silently drops the prompt (the reported first-run bug).
  const pendingPromptsRef = useRef<
    Map<
      string,
      { prompt: string; failMessage: string; timer: number; hintTimer: number }
    >
  >(new Map());
  // Latest sessions, read from the hold's async continuation (a closure over
  // `state` would go stale between the ready flip and the flush).
  const sessionsRef = useRef<HarnessSession[]>([]);

  // Forget a held prompt and stop both its timers. Returns the entry so a
  // caller can act on it (send / report), or undefined if nothing was held.
  const clearPending = useCallback((sessionId: string) => {
    const pending = pendingPromptsRef.current.get(sessionId);
    if (!pending) return undefined;
    window.clearTimeout(pending.timer);
    window.clearTimeout(pending.hintTimer);
    pendingPromptsRef.current.delete(sessionId);
    return pending;
  }, []);

  // Deliver a held prompt if its session is now ready; drop it (with the
  // failure toast) if the session exited first. A no-op while still waiting.
  const tryFlushPrompt = useCallback(
    (sessionId: string): void => {
      const pending = pendingPromptsRef.current.get(sessionId);
      if (!pending) return;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return; // not in client state yet — a later session.status retries
      if (session.ready) {
        // Delete BEFORE injecting so an overlapping flush can't double-send.
        clearPending(sessionId);
        void harness
          .injectInput(sessionId, pending.prompt)
          .catch(() => harness.showToast(pending.failMessage));
      } else if (session.status === "exited") {
        clearPending(sessionId);
        harness.showToast(pending.failMessage);
      }
    },
    [clearPending, harness.injectInput, harness.showToast],
  );

  // Register a prompt to be sent once its coding agent is ready. Sends
  // immediately if already ready. While waiting, a delayed hint (only if the
  // session is still not ready after a grace) points the user at terminal
  // setup — so first-run intent is held, not lost.
  const sendPromptWhenReady = useCallback(
    (sessionId: string, prompt: string, failMessage: string): void => {
      clearPending(sessionId);
      const timer = window.setTimeout(() => {
        if (clearPending(sessionId)) harness.showToast(failMessage);
      }, HELD_PROMPT_TIMEOUT_MS);
      const hintTimer = window.setTimeout(() => {
        if (pendingPromptsRef.current.has(sessionId)) {
          harness.showToast(
            "Finish signing in or dismiss any trust or setup prompt in the terminal — your prompt sends automatically once the coding agent is ready.",
          );
        }
      }, HELD_PROMPT_HINT_DELAY_MS);
      pendingPromptsRef.current.set(sessionId, {
        prompt,
        failMessage,
        timer,
        hintTimer,
      });
      tryFlushPrompt(sessionId);
    },
    [clearPending, harness.showToast, tryFlushPrompt],
  );

  // The ready/exited transition arrives as a session.status event → a new
  // sessions array → this effect flushes any prompt whose session just became
  // injectable. Event-driven, so no polling.
  useEffect(() => {
    sessionsRef.current = harness.state?.sessions ?? [];
    if (pendingPromptsRef.current.size === 0) return;
    for (const id of [...pendingPromptsRef.current.keys()]) tryFlushPrompt(id);
  }, [harness.state?.sessions, tryFlushPrompt]);

  // The dead pane's Resume button has to be as honest as a history row's tag,
  // and only the server can say whether the agent still holds the
  // conversation. Its verdict rides on the history row for this session, so
  // fetch this directory's history when we don't already have it. Safe to ask
  // for one directory: `loadHistory` replaces only the rows of the directories
  // it loaded and retains the rest, so this can't evict the rail's rows.
  const activeExitedSession =
    harness.state?.sessions.find(
      (session) =>
        session.id === harness.activeSessionId && session.status === "exited",
    ) ?? null;
  const deadResumeMode = activeExitedSession?.agentSessionId
    ? harness.history.find(
        (summary) =>
          summary.agentSessionId === activeExitedSession.agentSessionId,
      )?.resumeMode
    : "rehydrate";
  const deadCwdNeedingHistory =
    activeExitedSession?.agentSessionId != null && deadResumeMode === undefined
      ? activeExitedSession.cwd
      : null;
  const loadHistory = harness.loadHistory;
  useEffect(() => {
    if (deadCwdNeedingHistory) void loadHistory([deadCwdNeedingHistory]);
  }, [deadCwdNeedingHistory, loadHistory]);

  // The ONE choke point for session creation: the new session takes the
  // centre (unless its caller binds it first) and telemetry fires once. `cwd`
  // is already a project root by the time it gets here.
  const createSessionAt = async (
    cwd: string,
    agentHarness: HarnessKind,
    options: CreateSessionAtOptions = {},
  ): Promise<HarnessSession> => {
    // Activate the automatic home before a scaffold update can replace it;
    // its local draft and files must survive a later preparation failure.
    setComposing(options.keepComposerOpen === true);
    setReviewSummary(null);
    setOverviewOpen(false);
    setTemplatesOpen(false);
    if (options.select !== false) {
      navGenerationRef.current += 1;
      setView({ kind: "session" });
    }
    // Show the folder in the rail immediately — before the session POST, the pty
    // spawn, and the agent's scaffold/clone all resolve — so switching away
    // mid-creation never loses the in-progress project. Cleared on failure so a
    // rejected create leaves no ghost row; cleared automatically on success once
    // the real session/agent lands (see the store's pruning effect).
    harness.addPendingWorkspace(cwd);
    closeMobileDrawer();
    try {
      const session = await harness.createSession(
        {
          cwd,
          harness: agentHarness,
          ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
          ...(options.initialAttachments?.length ? { initialAttachments: options.initialAttachments } : {}),
          ...(options.initialSources?.length ? { initialSources: options.initialSources } : {}),
          ...(options.initialSetup ? { initialSetup: options.initialSetup } : {}),
          ...(options.initialUserInputPending ? { initialUserInputPending: true } : {}),
        },
        options.onCreated,
        { select: options.select !== false },
      );
      track("session.created");
      trackProduct("session.started", {
        harness_kind: agentHarness,
        origin: "user",
      });
      return session;
    } catch (err) {
      harness.removePendingWorkspace(cwd);
      throw err;
    }
  };

  const handleCreateSession = async (
    cwd: string,
    agentHarness: HarnessKind,
  ): Promise<void> => {
    await createSessionAt(cwd, agentHarness);
  };

  /**
   * SELECT A SESSION: a rail row, a past session in the history card, a
   * palette hit, the map panel's session list, Cmd/Ctrl+N. One click from
   * anywhere (flow 4.2.3): its workbench takes the centre, the rail does not
   * change, and a project's map gives way to it.
   */
  const openSession = (id: string): void => {
    navGenerationRef.current += 1;
    leaveDestinations();
    setView({ kind: "session" });
    closeMobileDrawer();
    harness.setActiveSessionId(id);
  };

  /**
   * NEW CHAT FROM THE RAIL (flow 4.5, Q11): a project header's `+` starts a
   * session at the project ROOT, unbound, and selects it. Unbound on purpose:
   * the `+` names a project, not an agent (Q5).
   */
  const handleNewChat = (project: { root: string; label: string }): void => {
    void createSessionAt(project.root, selectedHarness).catch((err: unknown) => {
      harness.showToast(
        errorMessage(err, `Couldn't start a chat in ${project.label}.`),
      );
    });
  };

  /**
   * START CHAT on the map's agent panel (flow 4.4.2): a NEW session at the
   * agent's project root, bound to the agent, at the top of the project's rows
   * (newest activity) and selected. Always new: the panel lists the agent's
   * existing sessions right above the button, so Start chat never quietly
   * reuses one. Bound BEFORE it is shown (design.md I6): `POST /sessions`
   * takes no agent, and selecting first would flash an unbound workbench.
   */
  const handleStartChat = (workflow: WorkflowInfo, projectId: string): void => {
    if (!projects) return;
    if (startChatPendingRef.current) return;
    startChatPendingRef.current = true;
    setStartChatPending(true);
    const cwd =
      projects.projectScope(projectId)?.cwd ??
      projects.sessionCwdForAgent(workflow.path);
    void (async () => {
      let createdId: string | null = null;
      try {
        const session = await createSessionAt(cwd, selectedHarness, {
          select: false,
          onCreated: (created) => {
            createdId = created.id;
            setPendingBindIds((previous) => new Set(previous).add(created.id));
          },
        });
        createdId = session.id;
        try {
          await harness.bindWorkflow(session.id, workflow.path);
        } catch {
          // Creation already succeeded. Keep that process alive and visible as
          // an unbound session rather than rolling it back.
          harness.showToast(
            `Chat started, but couldn't attach it to ${workflow.name}.`,
          );
        }
        openSession(session.id);
      } catch (err) {
        harness.showToast(errorMessage(err, "Couldn't start the chat."));
      } finally {
        if (createdId) {
          const id = createdId;
          setPendingBindIds((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
        }
        startChatPendingRef.current = false;
        setStartChatPending(false);
      }
    })();
  };

  /**
   * `×` on a live rail row (after the confirm) and End session… in the session
   * menu: the process ends and the row drops to the exited mark (Q4). The
   * selection stays where it is; if it was this session, the centre shows its
   * dead pane rather than jumping to another session (D43).
   */
  const handleEndSession = (id: string): void => {
    void harness.endSession(id).catch(() => {
      // endSession surfaced its own toast; the row keeps its state.
    });
  };

  /**
   * `×` on an exited rail row, and the dead pane's Close (Q4): hidden from the
   * rail, kept in History. If it was the selected session, the centre moves to
   * its project's map, the one place still about where you were.
   */
  const handleHideSession = (id: string): void => {
    setHiddenSessionIds((previous) => {
      const next = new Set(previous);
      next.add(id);
      saveUiPrefs({ hiddenSessionIds: Array.from(next) });
      return next;
    });
    if (harness.activeSessionId !== id) return;
    const session = state?.sessions.find((candidate) => candidate.id === id);
    const projectId = session?.agentMapIdentity?.projectId ?? null;
    harness.setActiveSessionId(null);
    if (projectId && projects?.projectScope(projectId)) {
      navGenerationRef.current += 1;
      setMapPanelPath(null);
      setView({ kind: "project", projectId });
    }
  };

  // One entry point for reviewing a past (transcript) session.
  const reviewPastSession = (summary: SessionSummary): void => {
    navGenerationRef.current += 1;
    setComposing(false);
    setReviewSummary(summary);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    closeMobileDrawer();
  };

  /**
   * SUBMIT, in order (flow-creation.md §4.4, D30, D31).
   *
   * 1. Creation completes before the chat starts: `POST /api/agents/scaffold`
   *    in the screen's project, the name derived from the idea. The server is
   *    the judge; a refusal (409 duplicate, 400 invalid) is thrown back to the
   *    screen, which shows it under the field. Nothing has started.
   * 2. One ordinary session opens in the project folder, bound to the agent.
   *    The ordinary type, the ordinary system prompt.
   * 3. Its first prompt is the idea, the files, the linked sources, and the
   *    planning instructions as session setup (§4.6). No English scaffold
   *    prompt is typed into any pty; the scaffold already happened.
   *
   * A session that fails to start after the agent exists is a session failure
   * and is reported as one: the agent is a row in the rail either way.
   */
  const handleComposerSubmitIdea = async (
    idea: string,
    attachments: readonly NewSessionAttachment[],
    sources: readonly string[],
  ): Promise<void> => {
    const project = composerProject;
    if (!project) {
      throw new Error("Pick a project first: New project opens the folder step.");
    }
    const template = project.template;
    const name = deriveAgentName(idea);
    // A RETRY AFTER THE SESSION FAILED reuses the agent the first attempt
    // created: the scaffold succeeded, so scaffolding again would be refused
    // as a duplicate of our own work. The screen stayed open with the files
    // and links intact, and this is what lets the second press finish the job.
    const retained = scaffoldedButUnstartedRef.current;
    const created =
      retained && samePath(retained.root, project.root) && retained.name === name
        ? retained
        : await harness.scaffoldAgent(
            project.root,
            name,
            template?.kind === "starter" ? template.id : "default",
          );
    scaffoldedButUnstartedRef.current = null;
    if (template && created !== retained) {
      // Product metric: "templates used", at the one choke point every
      // template surface now funnels through.
      trackProduct("agent.template_cloned", {
        template_slug: template.id,
        template_id: template.id,
        surface: project.templateSurface ?? "welcome",
      });
    }
    const setup = planningInstructions({
      agentName: created.name,
      projectLabel: project.label,
      template,
    });
    let session: HarnessSession;
    try {
      session = await createSessionAt(project.root, selectedHarness, {
        keepComposerOpen: true,
        initialPrompt: idea.trim(),
        initialAttachments: attachments.map((attachment) =>
          attachment.kind === "path"
            ? { kind: "path", path: attachment.path }
            : { kind: "inline", filename: attachment.name, dataUrl: attachment.dataUrl },
        ),
        initialSources: [...sources],
        initialSetup: setup,
        initialUserInputPending: true,
      });
    } catch (err) {
      // The agent exists (it is a row in the rail); the SESSION did not start.
      // Say exactly that under the field, keep the screen and its files, and
      // let the next press reuse the agent instead of scaffolding a duplicate.
      scaffoldedButUnstartedRef.current = {
        root: project.root,
        name: created.name,
        path: created.path,
      };
      throw new Error(
        `${created.name} was created, but its session didn't start. ${errorMessage(err, "")}`.trim(),
      );
    }
    setSetupBySession((previous) => new Map(previous).set(session.id, setup));
    try {
      await harness.bindWorkflow(session.id, created.path);
    } catch {
      // The session is live and already received the first prompt; only the
      // binding write failed. Keep it as an unbound folder session (as the
      // sibling-session path does) rather than reporting a start that did
      // happen, which would make the retry launch a second live session.
      harness.showToast(
        `Session started, but couldn't attach it to ${created.name}.`,
      );
    }
    harness.setActiveSessionId(session.id);
    // Only now does the screen give way: the agent exists and its session is
    // the active one, in the centre.
    setView({ kind: "session" });
    setComposing(false);
    setComposerProject(null);
  };

  return {
    selectedHarness,
    setSelectedHarness,
    harnessEntries,
    hiddenSessionIds,
    pendingBindIds,
    startChatPending,
    setupBySession,
    sessionNames,
    renameSession,
    deadResumeMode,
    sendPromptWhenReady,
    createSessionAt,
    handleCreateSession,
    openSession,
    handleNewChat,
    handleStartChat,
    handleEndSession,
    handleHideSession,
    reviewPastSession,
    handleComposerSubmitIdea,
  };
};

export type SessionActions = ReturnType<typeof useSessionActions>;
