import { useCallback, useRef, useState } from "react";

import type { SessionSummary } from "@shared/types";

/**
 * One place the user was working. Distinct from past-session "history" (ended
 * CLIs on disk): this is the visit stack behind the header's back/forward
 * chrome, and it covers every screen the shell can show — a session, a focused
 * agent, a past-session review, the composer home, and the template catalog.
 */
export type NavigationVisit =
  | { kind: "session"; sessionId: string; agentPath: string | null }
  | { kind: "agent"; agentPath: string }
  | { kind: "review"; summary: SessionSummary }
  | { kind: "composer" }
  | { kind: "templates" };

export interface NavigationHistoryState {
  entries: NavigationVisit[];
  index: number;
}

export const EMPTY_NAVIGATION_HISTORY: NavigationHistoryState = { entries: [], index: -1 };

const MAX_ENTRIES = 50;

export function sameNavigationVisit(a: NavigationVisit, b: NavigationVisit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "session" && b.kind === "session") return a.sessionId === b.sessionId;
  if (a.kind === "agent" && b.kind === "agent") return a.agentPath === b.agentPath;
  if (a.kind === "review" && b.kind === "review") {
    return a.summary.agentSessionId === b.summary.agentSessionId;
  }
  return a.kind === b.kind;
}

export function canGoBack(state: NavigationHistoryState): boolean {
  return state.index > 0;
}

export function canGoForward(state: NavigationHistoryState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

/** Push a visit. Truncates any forward branch (browser-style). Dedupes when
 *  the tip already names the same place. */
export function pushNavigationVisit(
  state: NavigationHistoryState,
  visit: NavigationVisit,
): NavigationHistoryState {
  const tip = state.index >= 0 ? state.entries[state.index] : null;
  if (tip && sameNavigationVisit(tip, visit)) {
    // The same place, told more precisely — a session that has since learned
    // which agent it belongs to. Refresh the tip in place so returning to it
    // restores the whole context, without branching the stack.
    if (JSON.stringify(tip) === JSON.stringify(visit)) return state;
    const entries = [...state.entries];
    entries[state.index] = visit;
    return { ...state, entries };
  }
  const kept = state.entries.slice(0, state.index + 1);
  const entries = [...kept, visit].slice(-MAX_ENTRIES);
  return { entries, index: entries.length - 1 };
}

export function moveNavigation(
  state: NavigationHistoryState,
  direction: "back" | "forward",
): { state: NavigationHistoryState; visit: NavigationVisit | null } {
  const can = direction === "back" ? canGoBack(state) : canGoForward(state);
  if (!can) return { state, visit: null };
  const index = direction === "back" ? state.index - 1 : state.index + 1;
  return { state: { ...state, index }, visit: state.entries[index] ?? null };
}

export interface NavigationHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Record the place the shell is showing now. Deduped against the tip, which
   *  is also what makes a restore idempotent: applying a visit re-derives the
   *  same place, and recording it again is a no-op rather than a new branch. */
  record: (visit: NavigationVisit) => void;
  /** Step one place and hand back the visit to apply, or null at the end. */
  goBack: () => NavigationVisit | null;
  goForward: () => NavigationVisit | null;
}

/** The visit stack behind the header's back/forward chrome. */
export function useNavigationHistory(): NavigationHistory {
  const [state, setState] = useState<NavigationHistoryState>(EMPTY_NAVIGATION_HISTORY);
  const stateRef = useRef(state);
  stateRef.current = state;

  const record = useCallback((visit: NavigationVisit): void => {
    const next = pushNavigationVisit(stateRef.current, visit);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const move = useCallback((direction: "back" | "forward"): NavigationVisit | null => {
    const next = moveNavigation(stateRef.current, direction);
    if (!next.visit) return null;
    stateRef.current = next.state;
    setState(next.state);
    return next.visit;
  }, []);

  return {
    canGoBack: canGoBack(state),
    canGoForward: canGoForward(state),
    record,
    goBack: () => move("back"),
    goForward: () => move("forward"),
  };
}
