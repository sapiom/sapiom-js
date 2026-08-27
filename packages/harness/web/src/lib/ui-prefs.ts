import type { RailAxis, RailSort } from "./project-tree";

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
  /**
   * Rows the user collapsed in the rail tree, as NAMESPACED keys
   * (`project:<abs path>`, `dir:<abs path>`) — see ProjectTreeRows' `dirKey` /
   * `projectKey`.
   *
   * The namespace is load-bearing, not decoration. A path is not unique across
   * row kinds: `~/x/agents` opened as a project is the exact string the
   * `agents` subdirectory inside `~/x` already uses, and the old bare-path key
   * collapsed both rows at once. It replaces `collapsedCwds`, whose stored
   * bare paths simply stop matching — a fold nobody can explain is worse than
   * a fold that resets once.
   */
  collapsedKeys?: string[];
  /**
   * How the rail files agents. Only `project` today; `deployment` is retired
   * (it bucketed a fact every agent row already prints as a glyph) and
   * `workspace` is replaced by it. Persisted so the explorer resumes as the
   * user left it — an unknown stored value falls back to the default rather
   * than rendering an axis that no longer exists.
   */
  railAxis?: RailAxis;
  /** Row/project order in the rail tree: newest activity first (default) or
   *  A–Z by name. */
  railSort?: RailSort;
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
