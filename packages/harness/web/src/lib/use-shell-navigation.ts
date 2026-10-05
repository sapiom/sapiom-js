/**
 * Moving around the shell without a click on a destination: Back/Forward over
 * every screen it can show, ⌘K / ⌘P for the palette, and Cmd/Ctrl+1..9 for
 * the selected project's sessions.
 */
import { useCallback, useEffect, useRef } from "react";

import type { NavigationVisit } from "./navigation-history";
import { useNavigationHistory } from "./navigation-history";
import { historyDirs } from "./history-meta";
import { samePath } from "./paths";
import { sessionForShortcut } from "./rail-sessions";
import { projectIdForAgent } from "./shell-projects";
import type { Dialogs } from "./use-dialogs";
import type { HarnessStateHook } from "./use-harness-state";
import type { ShellNav } from "./use-session-actions";

/**
 * A layer the COMMAND PALETTE must not open on top of.
 *
 * `.modal-backdrop` leads because it is the one thing every overlay in this app
 * actually has, and because `CommandPalette` itself carries no `role` — a
 * role-only selector (the shape the Escape handler in `App.tsx` uses) cannot see it,
 * so a guard written that way looks correct and detects nothing.
 *
 * THE OVERVIEW IS CARVED OUT, and it is not an oversight: the palette is
 * deliberately reachable by shortcut while the Overview is up, and navigating
 * from it dismisses the Overview rather than stacking behind it. That is a
 * written contract with a spec behind it — `welcome.spec.ts`'s "the palette's
 * Browse templates, opened over the Overview, leaves it (never stacks)". The
 * Overview wears both `role="dialog"` and `aria-modal="true"`, so excluding it
 * has to be done on each clause rather than by dropping a class from the list.
 *
 * THE HELP CARD IS NOT CARVED OUT, although it wears `.overview-modal` too:
 * that class is `OverviewModal`'s visual recipe, shared by `HelpOverlay`
 * ("How Studio is organised"), and the help card has no contract with the
 * palette. Navigating from the palette does not dismiss it, so the palette
 * would stack over it exactly as it did over a dialog. Its own class leads the
 * list so the per-clause carve-out below cannot let it through.
 *
 * DELIBERATELY NOT the dialog shell's layer selector. That one answers "which
 * layer owns Tab", where the Overview IS a layer and belongs in the list. This
 * one answers "may ⌘K open here", where it does not. Same shape, different
 * question; collapsing them would break the contract above.
 */
const PALETTE_BLOCKING_LAYER_SELECTOR = [
  ".modal-backdrop",
  ".help-overlay",
  '[role="dialog"]:not(.overview-modal)',
  '[role="alertdialog"]:not(.overview-modal)',
  '[aria-modal="true"]:not(.overview-modal)',
].join(",");

export const useShellNavigation = ({
  harness,
  dialogs,
  nav,
  hiddenSessionIds,
  pendingBindIds,
}: {
  harness: HarnessStateHook;
  dialogs: Dialogs;
  nav: ShellNav;
  hiddenSessionIds: ReadonlySet<string>;
  pendingBindIds: ReadonlySet<string>;
}) => {
  const { view, setView, navGenerationRef, setMapPanelPath } = nav;
  const viewProjectId = view.kind === "session" ? null : view.projectId;
  const {
    paletteOpen,
    setPaletteOpen,
    composing,
    setComposing,
    composerProject,
    setComposerProject,
    reviewSummary,
    setReviewSummary,
    templatesOpen,
    setTemplatesOpen,
    setOverviewOpen,
  } = dialogs;
  // The session door the number keys take, assigned by the shell once it
  // renders with state.
  const openSessionRef = useRef<((sessionId: string) => void) | null>(null);
  // Back/forward across every screen the shell can show. The stack is fed by
  // the place the shell IS (derived below), not by instrumenting each door, so
  // a new way into a view is navigable the day it lands.
  const navHistory = useNavigationHistory();

  // Cmd+K (any platform) or Cmd/Ctrl+P — "jump to" like Cmd+P in Cursor/VS Code.
  // Cmd/Ctrl+1..9 selects the Nth session of the SELECTED project in rail
  // order (flow-navigation.md Q2): the project whose map is showing, else the
  // selected session's project. Resolved by the same module the rail renders
  // from, so a number key can never address a row the rail is not showing.
  // The strip this replaced kept its own copy of that filter here, and the two
  // drifted the moment a project was selected over an exited session.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "p")) {
        // A LAYER ON TOP SWALLOWS THE SHORTCUT. Unguarded, ⌘K stacked the
        // palette over an open dialog and native Tab then walked out of the
        // palette into the dialog behind it. A surface cannot contain focus for
        // a surface it does not own, so the fix is here rather than in either.
        // See the selector for what it excludes and why it is not the dialog
        // shell's list.
        //
        // PREVENTED, THEN DROPPED — never returned unhandled. This handler owns
        // ⌘P as well as ⌘K, and ⌘P is the browser's PRINT shortcut: returning
        // early without preventing it opened a native print preview over the
        // dialog, which is worse than the stacking it was added to stop. The
        // shortcut does nothing here, exactly as it did nothing before.
        if (document.querySelector(PALETTE_BLOCKING_LAYER_SELECTOR)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const target = sessionForShortcut(Number(e.key), {
          // A Start chat still binding is not in the rail, so not countable.
          sessions: (harness.state?.sessions ?? []).filter(
            (session) => !pendingBindIds.has(session.id),
          ),
          hidden: hiddenSessionIds,
          now: Date.now(),
          shownProjectId: viewProjectId,
          activeSessionId: harness.activeSessionId,
        });
        if (target) {
          e.preventDefault();
          openSessionRef.current?.(target.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    harness.state?.sessions,
    harness.activeSessionId,
    hiddenSessionIds,
    pendingBindIds,
    viewProjectId,
  ]);

  // Opening the palette loads history for the same directories the rail's
  // popover asks for — one shared builder, so whichever opens second
  // coalesces against the first instead of re-fetching every directory.
  useEffect(() => {
    if (!paletteOpen || !harness.state) return;
    const dirs = historyDirs(
      harness.state.sessions,
      harness.settings?.recentDirs ?? [],
      harness.activeSessionId,
    );
    if (dirs.length > 0) void harness.loadHistory(dirs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen]);

  // The place the shell is showing, in the same precedence `centrePane` uses.
  // It is derived rather than pushed at each door so every screen is
  // navigable, and recording it is idempotent: applying a visit re-derives the
  // same place, which dedupes against the tip instead of branching the stack.
  const recordVisit = navHistory.record;
  const activeSessionIdForNav = harness.activeSessionId;
  // Set by applyVisit for the single re-derivation its state change triggers,
  // so the record effect skips that one run and Back/Forward stays a pure
  // replay rather than truncating the forward stack.
  const applyingVisitRef = useRef(false);
  useEffect(() => {
    if (applyingVisitRef.current) {
      applyingVisitRef.current = false;
      return;
    }
    if (templatesOpen) {
      recordVisit({ kind: "templates" });
    } else if (reviewSummary) {
      recordVisit({ kind: "review", summary: reviewSummary });
    } else if (composing) {
      recordVisit({ kind: "composer", project: composerProject });
    } else if (view.kind === "project") {
      recordVisit({ kind: "agent-map", projectId: view.projectId });
    } else if (view.kind === "agent") {
      recordVisit({ kind: "agent", agentPath: view.path });
    } else if (activeSessionIdForNav) {
      recordVisit({
        kind: "session",
        sessionId: activeSessionIdForNav,
        agentPath: null,
      });
    }
  }, [
    recordVisit,
    view,
    templatesOpen,
    reviewSummary,
    composing,
    composerProject,
    activeSessionIdForNav,
  ]);

  const setActiveSessionId = harness.setActiveSessionId;
  const applyVisit = useCallback(
    (visit: NavigationVisit | null): void => {
      if (!visit) return;
      navGenerationRef.current += 1;
      // Replaying, not navigating: tell the record effect to skip the one run
      // this state change triggers. See applyingVisitRef above.
      applyingVisitRef.current = true;
      setOverviewOpen(false);
      setTemplatesOpen(visit.kind === "templates");
      // The screen derives its label and creation root from the project the
      // visit was recorded with, not from whichever project opened it last.
      // A project removed since the visit was recorded is not restored: the
      // composer would otherwise create into a root the rail no longer holds.
      const visitProject = visit.kind === "composer" ? visit.project : null;
      const scopes = harness.state?.workspaceScopes ?? [];
      const visitProjectOpen =
        !visitProject ||
        scopes.some((scope) => samePath(scope.cwd, visitProject.root));
      setComposing(visit.kind === "composer" && visitProjectOpen);
      if (visit.kind === "composer") {
        setComposerProject(
          visitProjectOpen ? visitProject ?? null : null,
        );
      }
      setReviewSummary(visit.kind === "review" ? visit.summary : null);
      // A map and the agent modal over it are one place: stepping between
      // them keeps the pick, as closing the modal does (I9).
      if (visit.kind !== "agent-map" && visit.kind !== "agent")
        setMapPanelPath(null);
      if (visit.kind === "agent-map") {
        setView(
          scopes.some((scope) => scope.projectId === visit.projectId)
            ? { kind: "project", projectId: visit.projectId }
            : { kind: "session" },
        );
      } else if (visit.kind === "project") {
        // A visit recorded before a project had its durable identity.
        const projectId = scopes.find(
          (scope) => scope.workspaceKey === visit.workspaceKey,
        )?.projectId;
        setView(projectId ? { kind: "project", projectId } : { kind: "session" });
      } else if (visit.kind === "agent") {
        const projectId = projectIdForAgent(visit.agentPath, harness.state);
        setView(
          projectId
            ? { kind: "agent", projectId, path: visit.agentPath }
            : { kind: "session" },
        );
      } else {
        setView({ kind: "session" });
        if (visit.kind === "session") setActiveSessionId(visit.sessionId);
      }
    },
    [harness.state, setActiveSessionId],
  );


  return { navHistory, applyVisit, openSessionRef };
};
export type ShellNavigation = ReturnType<typeof useShellNavigation>;
