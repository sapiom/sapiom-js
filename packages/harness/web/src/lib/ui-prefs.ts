/**
 * Persisted information-architecture state ("the Studio holds context
 * on my IA as I resume") — workspace-folder collapse, rail/right-pane
 * collapse, and the active right tab all survive a reload, alongside the pane
 * widths use-pane-widths.ts already keeps.
 *
 * One JSON blob under one key: partial writes merge into what's stored, so
 * App and WorkflowsRail can each persist only the slice they own.
 */

export interface UiPrefs {
  railCollapsed?: boolean;
  rightCollapsed?: boolean;
  rightTab?: "canvas" | "steps" | "code";
  /** Workspace cwds the user collapsed in the rail tree. */
  collapsedCwds?: string[];
  /** The agent NEW sessions default to — set from the composer's provider
   *  dropdown (a session's own agent is pinned at launch, so the switch is
   *  honestly scoped to the next session) and read by the new-session
   *  dialog's picker. */
  preferredHarness?: "claude-code" | "codex";
  /** User renames, keyed by session id. Client-side only: the server has no
   *  rename endpoint yet, so the name lives with the UI
   *  arrangement it belongs to. */
  sessionNames?: Record<string, string>;
  /** Manual height (px) for the canvas bottom inspector panel, set by
   *  dragging its top edge. Null/absent = auto: the panel hugs its content
   *  up to half the pane. Double-clicking the handle clears it. */
  canvasInspectorHeight?: number | null;
}

const STORAGE_KEY = "sapiom-harness-ui-prefs";

export function loadUiPrefs(): UiPrefs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UiPrefs) : {};
  } catch {
    // Corrupt/blocked storage never breaks the shell — fall back to defaults.
    return {};
  }
}

export function saveUiPrefs(patch: UiPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadUiPrefs(), ...patch }));
  } catch {
    // Private mode / quota — persistence is best-effort, the session state wins.
  }
}
