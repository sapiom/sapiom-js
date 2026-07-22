import { useRef, useState } from "react";
import type { JSX, RefObject } from "react";

import {
  GALLERY_TEMPLATES,
  STARTER_TEMPLATES,
  TEMPLATES_PIN,
  templateDirSuggestion,
  type StudioTemplate,
} from "../lib/templates";
import { useDismissable } from "../lib/use-dismissable";
import { Icon } from "./Icon";
import { TemplateDetail } from "./TemplateDetail";

interface TemplatesDialogProps {
  /** Seeds the destination suggestion (a new folder under the launch dir). */
  launchDir: string | null;
  onClose: () => void;
  /** The real handoff (App.handleUseTemplate): starts a session in the
   *  destination folder and hands the agent the clone or scaffold prompt. */
  onUse: (dir: string, template: StudioTemplate) => Promise<void>;
  /** The button that opened the dialog — Escape returns focus to it. */
  triggerRef?: RefObject<HTMLElement | null>;
}

function TemplateRow({
  template,
  isSelected,
  onSelect,
}: {
  template: StudioTemplate;
  isSelected: boolean;
  onSelect: (template: StudioTemplate) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      className={"template-row" + (isSelected ? " is-selected" : "")}
      data-testid={`template-row-${template.id}`}
      onClick={() => onSelect(template)}
    >
      <span className="template-row-name">{template.name}</span>
      <span className="template-row-desc">{template.description}</span>
    </button>
  );
}

/**
 * Start from a template (templates journey v0): browse the curated index,
 * preview a template's real manifest, and use it — which starts a session in
 * a new destination folder and hands the agent the real operation (the
 * clone MCP tool for gallery templates, `sapiom agents init -t` for bundled
 * starters). The cloned folder then joins the rail as a workspace and
 * editing/running is the normal loop — no special path. See lib/templates.ts
 * for the provenance of every word in the index.
 */
export function TemplatesDialog({ launchDir, onClose, onUse, triggerRef }: TemplatesDialogProps): JSX.Element {
  const [selected, setSelected] = useState<StudioTemplate>(GALLERY_TEMPLATES[0]);
  const [dest, setDest] = useState(() => templateDirSuggestion(GALLERY_TEMPLATES[0], launchDir));
  // A hand-edited destination survives template switches; an untouched one
  // follows the selection so the default always names the picked template.
  const [destEdited, setDestEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onClose, containerRef: panelRef, triggerRef });

  const select = (template: StudioTemplate): void => {
    setSelected(template);
    setError(null);
    if (!destEdited) setDest(templateDirSuggestion(template, launchDir));
  };

  const submit = async (): Promise<void> => {
    const trimmed = dest.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUse(trimmed, selected);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-templates"
        role="dialog"
        aria-label="Start from a template"
        data-testid="templates-dialog"
        ref={panelRef}
      >
        <div className="modal-header">
          Start from a template
          <button
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            disabled={busy}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="templates-layout">
          <div className="templates-list" role="listbox" aria-label="Templates">
            <div className="templates-list-section">Gallery</div>
            {GALLERY_TEMPLATES.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                isSelected={template.id === selected.id}
                onSelect={select}
              />
            ))}
            <div className="templates-list-section">Starters</div>
            {STARTER_TEMPLATES.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                isSelected={template.id === selected.id}
                onSelect={select}
              />
            ))}
            {/* Honest curation: no listing API exists yet, so
                this index is a pin, and the note says which one. */}
            <p className="templates-pin-note" data-testid="templates-pin-note">
              Pinned from the harness {TEMPLATES_PIN.harnessVersion} gallery. Live browse is
              dashboard only until a listing API ships.
            </p>
          </div>

          <TemplateDetail template={selected} />
        </div>

        <div className="modal-actions templates-actions">
          <div className="templates-dest">
            <input
              className="modal-input"
              value={dest}
              placeholder="/path/to/new-folder"
              aria-label="Destination folder"
              data-testid="template-dest-input"
              disabled={busy}
              onChange={(e) => {
                setDest(e.target.value);
                setDestEdited(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            {error ? (
              <span className="modal-error templates-dest-error">{error}</span>
            ) : (
              <span className="templates-dest-hint">A session starts here and sets it up.</span>
            )}
          </div>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary modal-primary-cta"
            data-testid="template-use-btn"
            disabled={busy || !dest.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Starting…" : "Use template"}
          </button>
        </div>
      </div>
    </div>
  );
}
