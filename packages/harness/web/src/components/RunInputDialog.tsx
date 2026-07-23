/**
 * Run-input dialog — opened by Local Run and Prod Run buttons before firing
 * the run. Lets users supply the entry-step input as JSON instead of always
 * using the empty default.
 *
 * Prefill priority (highest to lowest):
 *   1. Last-used input for this workflow path (persisted across opens).
 *   2. A skeleton JSON object derived from the entry step's declared input
 *      fields (when the canvas graph is available).
 *   3. Empty object `{}` as the safe fallback.
 *
 * Design tokens: reuses .modal, .modal-backdrop, .modal-header, .modal-input,
 * .modal-actions, .modal-error, .btn-primary, .btn-ghost — no new palette
 * entries. The textarea variant (.run-input-editor) is defined in styles.css.
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { CanvasGraph } from "../lib/canvas-graph";
import { stepInputFields } from "../lib/canvas-graph";
import { Icon } from "./Icon";
import { useDismissable } from "../lib/use-dismissable";

// ---------------------------------------------------------------------------
// localStorage key helpers (one key per workflow path)
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "sapiom:run-input:";

function storageKey(workflowPath: string): string {
  // Encode the path so path separators don't break anything.
  return STORAGE_PREFIX + encodeURIComponent(workflowPath);
}

export function loadLastInput(workflowPath: string): string | null {
  try {
    return localStorage.getItem(storageKey(workflowPath));
  } catch {
    return null;
  }
}

export function saveLastInput(workflowPath: string, raw: string): void {
  try {
    localStorage.setItem(storageKey(workflowPath), raw);
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Skeleton derivation (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build a skeleton JSON object from the entry step's declared input fields.
 * Each field gets a placeholder string value `"<type>"` so the user can see
 * both the key name and the expected type before editing.
 *
 * Returns `"{}"` when no graph is available or the entry node has no inputs.
 */
export function buildSkeleton(graph: CanvasGraph | null): string {
  if (!graph) return "{}";
  const entryNode =
    graph.nodes.find((n) => n.id === graph.entry) ??
    graph.nodes.find((n) => n.kind === "entry") ??
    null;
  if (!entryNode) return "{}";
  const fields = stepInputFields(entryNode);
  if (fields.length === 0) return "{}";
  const obj: Record<string, string> = {};
  for (const { name, type } of fields) {
    obj[name] = `<${type}>`;
  }
  return JSON.stringify(obj, null, 2);
}

/**
 * The human-readable hint listing the entry step's expected field names +
 * types. Empty string when no graph is available or no fields are declared.
 */
export function buildFieldHint(graph: CanvasGraph | null): string {
  if (!graph) return "";
  const entryNode =
    graph.nodes.find((n) => n.id === graph.entry) ??
    graph.nodes.find((n) => n.kind === "entry") ??
    null;
  if (!entryNode) return "";
  const fields = stepInputFields(entryNode);
  if (fields.length === 0) return "";
  const parts = fields.map(({ name, type, required }) => `${name}: ${type}${required ? "" : "?"}`);
  return `Entry step expects: ${parts.join(", ")}`;
}

/**
 * Compute the initial editor value for a fresh dialog open, applying the
 * prefill priority: last-used > skeleton > `{}`.
 */
export function computeInitialValue(workflowPath: string, graph: CanvasGraph | null): string {
  const lastUsed = loadLastInput(workflowPath);
  if (lastUsed !== null) return lastUsed;
  return buildSkeleton(graph);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Which run route this dialog will fire when submitted. */
export type RunKind = "local" | "prod";

export interface RunInputDialogProps {
  /** The workflow path — used to key last-used persistence. */
  workflowPath: string;
  /** Which run button opened this dialog. */
  kind: RunKind;
  /** The canvas graph for the bound workflow, if available. Used for skeleton
   *  derivation and the field hint line. May be null (graph not yet posted). */
  graph: CanvasGraph | null;
  /** Called when the user confirms the run — receives the parsed input. */
  onRun: (input: unknown) => void;
  onClose: () => void;
}

export function RunInputDialog({
  workflowPath,
  kind,
  graph,
  onRun,
  onClose,
}: RunInputDialogProps): JSX.Element {
  const [value, setValue] = useState<string>(() => computeInitialValue(workflowPath, graph));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea on open so the user can start typing immediately.
  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  useDismissable(true, { onDismiss: onClose, containerRef: panelRef });

  const fieldHint = buildFieldHint(graph);
  const title = kind === "local" ? "Local Run" : "Prod Run";

  const submit = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.trim() || "{}");
    } catch {
      setJsonError("Invalid JSON — fix the syntax and try again.");
      return;
    }
    // Persist as last-used for this workflow path before firing.
    saveLastInput(workflowPath, value.trim() || "{}");
    onRun(parsed);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd/Ctrl+Enter submits; Shift+Enter inserts a newline; plain Enter is a
    // newline too (the editor holds multi-line JSON, so Enter must not run).
    if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-run-input"
        role="dialog"
        aria-label={`${title} — set input`}
        data-testid="run-input-dialog"
        ref={panelRef}
      >
        <div className="modal-header">
          {title}
          <button
            type="button"
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="run-input-body">
          {fieldHint && (
            <p className="run-input-hint" data-testid="run-input-hint">
              {fieldHint}
            </p>
          )}
          <textarea
            ref={textareaRef}
            className="run-input-editor"
            data-testid="run-input-editor"
            aria-label="Run input (JSON)"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (jsonError) setJsonError(null);
            }}
            onKeyDown={handleKeyDown}
          />
          {jsonError && (
            <span className="modal-error" data-testid="run-input-error" role="alert">
              {jsonError}
            </span>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary modal-primary-cta"
            data-testid="run-input-submit"
            onClick={submit}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
