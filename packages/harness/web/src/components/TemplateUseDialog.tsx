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

import { useState } from "react";
import type { JSX, RefObject } from "react";

import { errorMessage, type FsListResponse } from "../lib/api";
import type { StudioTemplate } from "../lib/templates";
import { Dialog } from "./Dialog";
import { FolderField } from "./FolderField";

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

  const submit = async (): Promise<void> => {
    const trimmed = dest.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch (err) {
      // The server's sentence, not the wire shape it arrives in: a starter now
      // goes through `POST /api/agents/scaffold` (SAP-2981), so a real refusal
      // — a name already taken there, a folder Studio doesn't show as a project
      // — lands here and has to be readable.
      setError(errorMessage(err, "Couldn't use this template."));
      setBusy(false);
    }
  };

  return (
    <Dialog
      className="modal-confirm modal-template-use"
      testId="template-use-dialog"
      title={`Use ${template.name}`}
      onClose={onCancel}
      onSubmit={() => void submit()}
      // Never dismissable mid-flight: the session is already being created, and
      // pulling the dialog would leave the user with no report of how it went.
      dismissable={!busy}
      closeDisabled={busy}
      triggerRef={triggerRef}
      // No `object: "template"` here: it would shadow the nested FolderField's
      // `object: "directory"`, and that value is what makes before-send drop
      // the user's folder names from click text.
      tracking={{ dialog: "template_use" }}
      actions={
        <>
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
        </>
      }
    >
      <FolderField
        value={dest}
        onChange={setDest}
        onSubmit={() => void submit()}
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
    </Dialog>
  );
}
