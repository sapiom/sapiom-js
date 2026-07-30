/**
 * Confirm where a template lands, and nothing else.
 *
 * Using a template is one decision — the folder — and it used to be asked by a
 * permanent bar pinned under the browser: a hint, a full-width path field and
 * two buttons, mounted the moment the dialog opened. That put a commit control
 * under a surface you were still reading, and charged every visit the height of
 * a decision most visits never make.
 *
 * A dialog is the honest shape for it: it appears when you say "use this", asks
 * the single question, and takes Return for an answer. The question uses the
 * SAME directory picker the new-session modal and the add-workspace doors use —
 * browse, drill in, recent folders, "this one doesn't exist yet" — because
 * "where does this land" is one question with one good answer, and a bare path
 * textbox was a worse second answer to it.
 */

import { useRef, useState } from "react";
import type { JSX, RefObject } from "react";

import type { FsListResponse } from "../lib/api";
import type { StudioTemplate } from "../lib/templates";
import { useDismissable } from "../lib/use-dismissable";
import { FolderBrowser } from "./FolderBrowser";
import { Icon } from "./Icon";

export function TemplateUseDialog({
  template,
  initialDest,
  recentDirs,
  listDir,
  onCancel,
  onConfirm,
  triggerRef,
}: {
  template: StudioTemplate;
  /** Suggested folder, already derived from the template and the project root. */
  initialDest: string;
  /** Recent folders, for the picker's chip row. */
  recentDirs: string[];
  listDir: (path?: string) => Promise<FsListResponse>;
  onCancel: () => void;
  /** Rejects with a message to show in place of the hint. */
  onConfirm: (dest: string) => Promise<void>;
  /** The control that opened this — Escape returns focus to it. */
  triggerRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const [dest, setDest] = useState(initialDest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Never dismissable mid-flight: the session is already being created, and
  // pulling the dialog would leave the user with no report of how it went.
  useDismissable(!busy, { onDismiss: onCancel, containerRef: panelRef, triggerRef });

  const submit = async (): Promise<void> => {
    const trimmed = dest.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-confirm modal-template-use"
        role="dialog"
        aria-label={`Use ${template.name}`}
        data-testid="template-use-dialog"
        ref={panelRef}
      >
        <div className="modal-header">
          Use {template.name}
          <button
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            disabled={busy}
            onClick={onCancel}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="modal-body">
          <FolderBrowser
            value={dest}
            onChange={setDest}
            onOpen={() => void submit()}
            recentDirs={recentDirs}
            listDir={listDir}
          />
          {error ? (
            <p className="modal-error" data-testid="template-use-error">
              {error}
            </p>
          ) : (
            <p className="modal-field-hint">
              A session starts here and sets the template up in it. A folder that does not exist yet
              is created.
            </p>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary modal-primary-cta"
            data-testid="template-use-confirm"
            disabled={busy || !dest.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </div>
    </div>
  );
}
