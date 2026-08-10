/**
 * "Open in editor": which editor, and the URL that reaches it.
 *
 * Every supported editor is a VS Code descendant or copies its handler shape,
 * so one template — `<scheme>://file<path>` — covers all of them; only the
 * scheme differs. That is the whole reason this is a preference and not a
 * detection: the OS resolves the scheme and tells us nothing back, so a machine
 * with Cursor but no VS Code answered the old hardcoded `vscode://` with
 * silence, indistinguishable from success.
 */
import { EDITOR_KINDS, type EditorKind } from "@shared/types";

/** The editor the picker starts on, and what an older settings file means. */
export const DEFAULT_EDITOR: EditorKind = EDITOR_KINDS[0];

const EDITOR_LABELS: Record<EditorKind, string> = {
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  cursor: "Cursor",
  windsurf: "Windsurf",
  zed: "Zed",
};

/** Menu-order options for the Settings picker. */
export const EDITOR_OPTIONS: ReadonlyArray<{ kind: EditorKind; label: string }> =
  EDITOR_KINDS.map((kind) => ({ kind, label: EDITOR_LABELS[kind] }));

/** The stored preference, or the default when it is absent or unrecognised
 *  (a settings file written by a newer build, downgraded). */
export function resolveEditor(editor: string | undefined): EditorKind {
  return EDITOR_KINDS.includes(editor as EditorKind) ? (editor as EditorKind) : DEFAULT_EDITOR;
}

export function editorLabel(editor: string | undefined): string {
  return EDITOR_LABELS[resolveEditor(editor)];
}

/**
 * The deep link that opens `path` in `editor`.
 *
 * The handler expects a POSIX-shaped absolute path after `file`, so a Windows
 * path is normalised to `/C:/Users/…` — `vscode://fileC:\Users\…` (what
 * concatenating a raw Windows path produces) opens nothing at all.
 */
export function editorUrl(editor: string | undefined, path: string): string {
  const posix = path.replace(/\\/g, "/");
  const absolute = posix.startsWith("/") ? posix : `/${posix}`;
  return `${resolveEditor(editor)}://file${encodeURI(absolute)}`;
}
