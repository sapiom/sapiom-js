import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, RefObject } from "react";

import type { TemplateDetailView, TemplateListResponse } from "@shared/types";

import {
  STARTER_TEMPLATES,
  complexityBasisSummary,
  formatComplexity,
  groupByCategory,
  matchesQuery,
  templateDirSuggestion,
  type GalleryTemplate,
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
  /** The live catalog fetchers (server relays core; the key stays server-side). */
  listTemplates: () => Promise<TemplateListResponse>;
  getTemplate: (id: string) => Promise<TemplateDetailView>;
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
      {/* Size and involvement: how many steps, and how much judgment they carry.
          The band is what replaced a per-run cost estimate core could only
          compute for 5 of 26 templates. An em dash means the response carried no
          band at all — see formatComplexity. */}
      {template.kind === "gallery" && (
        <span className="template-row-meta">
          <span className="template-row-steps">
            {template.stepCount} {template.stepCount === 1 ? "step" : "steps"}
          </span>
          <span
            className="template-row-complexity"
            title={
              template.complexity
                ? complexityBasisSummary(template.complexity)
                : "This catalog response carried no complexity band."
            }
          >
            {formatComplexity(template.complexity)}
          </span>
        </span>
      )}
    </button>
  );
}

/**
 * Start from a template: browse the LIVE catalog (the same one the dashboard's
 * Template library renders, relayed by the harness server from core so the API
 * key never reaches the browser), preview a template's real manifest, and use it
 * — which starts a session in a new destination folder and hands the agent the
 * real operation (the clone MCP tool for catalog templates, `sapiom agents init
 * -t` for bundled starters). The cloned folder then joins the rail as a
 * workspace and editing/running is the normal loop — no special path.
 *
 * The catalog is fetched, not pinned: this dialog previously rendered a
 * hardcoded two-entry copy while the dashboard showed 26. If the fetch degrades
 * (signed out, core unreachable) the bundled starters still work offline and the
 * dialog SAYS the gallery is unavailable rather than presenting a short list as
 * if it were complete.
 */
export function TemplatesDialog({
  launchDir,
  onClose,
  onUse,
  listTemplates,
  getTemplate,
  triggerRef,
}: TemplatesDialogProps): JSX.Element {
  const [catalog, setCatalog] = useState<TemplateListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<StudioTemplate>(STARTER_TEMPLATES[0]);
  const [dest, setDest] = useState(() => templateDirSuggestion(STARTER_TEMPLATES[0], launchDir));
  // A hand-edited destination survives template switches; an untouched one
  // follows the selection so the default always names the picked template.
  // A REF, not state: the catalog effect below runs once (`[]` deps), so a
  // state closure would capture `false` permanently and overwrite a destination
  // the user typed while the fetch was in flight.
  const destEdited = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onClose, containerRef: panelRef, triggerRef });

  // Selection follows the loaded catalog: default to the first gallery template
  // once it arrives, but never clobber a choice the user already made.
  const selectionTouched = useRef(false);
  useEffect(() => {
    let cancelled = false;
    listTemplates()
      .then((response) => {
        if (cancelled) return;
        setCatalog(response);
        const first = response.templates[0];
        if (first && !selectionTouched.current) {
          const template: GalleryTemplate = { ...first, kind: "gallery" };
          setSelected(template);
          if (!destEdited.current) setDest(templateDirSuggestion(template, launchDir));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // Intentionally once-per-open: the dialog is short-lived and the server
    // caches the upstream call, so re-fetching on a keystroke would be waste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (template: StudioTemplate): void => {
    selectionTouched.current = true;
    setSelected(template);
    setError(null);
    if (!destEdited.current) setDest(templateDirSuggestion(template, launchDir));
  };

  const gallery = useMemo<GalleryTemplate[]>(
    () => (catalog?.templates ?? []).map((template) => ({ ...template, kind: "gallery" as const })),
    [catalog],
  );
  const groups = useMemo(
    () => groupByCategory(gallery.filter((template) => matchesQuery(template, query))),
    [gallery, query],
  );
  const starters = useMemo(
    () => STARTER_TEMPLATES.filter((template) => matchesQuery(template, query)),
    [query],
  );
  const resultCount = groups.reduce((sum, group) => sum + group.templates.length, 0) + starters.length;

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

  /** Why the gallery is short, in the user's terms — silence here is what made
   *  the pinned two-entry list look like the whole catalog. */
  const degraded = (): string | null => {
    if (loadError) return `Could not load the template gallery: ${loadError}`;
    if (!catalog) return null;
    if (catalog.source === "live") return null;
    return catalog.reason === "signed-out"
      ? "Sign in to Sapiom to browse the template gallery. The bundled starters below work offline."
      : "The template gallery is unreachable right now. The bundled starters below work offline.";
  };
  const degradedNote = degraded();

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
          <div className="templates-sidebar">
            <input
              className="modal-input templates-search"
              value={query}
              placeholder="Search templates…"
              aria-label="Search templates"
              data-testid="template-search"
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="templates-list" role="listbox" aria-label="Templates">
              {catalog === null && !loadError && (
                <div className="templates-list-empty" data-testid="templates-loading">
                  Loading templates…
                </div>
              )}
              {degradedNote && (
                <div className="templates-list-note" data-testid="templates-degraded">
                  {degradedNote}
                </div>
              )}
              {groups.map((group) => (
                <div key={group.label}>
                  <div className="templates-list-section">
                    {group.label}
                    <span className="templates-list-count">{group.templates.length}</span>
                  </div>
                  {group.templates.map((template) => (
                    <TemplateRow
                      key={template.id}
                      template={template}
                      isSelected={template.id === selected.id}
                      onSelect={select}
                    />
                  ))}
                </div>
              ))}
              {starters.length > 0 && (
                <>
                  <div className="templates-list-section">
                    Bundled starters
                    <span className="templates-list-count">{starters.length}</span>
                  </div>
                  {starters.map((template) => (
                    <TemplateRow
                      key={template.id}
                      template={template}
                      isSelected={template.id === selected.id}
                      onSelect={select}
                    />
                  ))}
                </>
              )}
              {catalog !== null && resultCount === 0 && (
                <div className="templates-list-empty" data-testid="templates-no-results">
                  No templates match “{query}”.
                </div>
              )}
            </div>
          </div>

          <TemplateDetail template={selected} getTemplate={getTemplate} />
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
                destEdited.current = true;
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
