import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type { TemplateDetailView, TemplateListResponse } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import {
  NO_FILTER,
  filterTemplates,
  isFiltered,
  type TemplateFilter,
} from "../lib/template-facets";
import {
  STARTER_TEMPLATES,
  matchesQuery,
  templateDirSuggestion,
  type GalleryTemplate,
  type StudioTemplate,
} from "../lib/templates";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { TemplateCard } from "./TemplateCard";
import { TemplateDetail } from "./TemplateDetail";
import { TemplateFilters } from "./TemplateFilters";
import { TemplateUseDialog } from "./TemplateUseDialog";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { TrackScope } from "./analytics/TrackScope";

interface TemplatesPanelProps {
  /** Seeds the destination suggestion — the resolved project root, shared with
   *  the add-workspace doors so the two can never disagree about where new
   *  projects land. */
  projectRoot: string | null;
  /** Forwarded to the confirm dialog's directory picker. */
  recentDirs: string[];
  listDir: (path?: string) => Promise<FsListResponse>;
  /** Leave the browser and return to the session workbench. */
  onExit: () => void;
  /** Starts a session in the destination folder and hands over the prompt. */
  onUse: (dir: string, template: StudioTemplate) => Promise<void>;
  /** The live catalog fetchers (the server relays core; the key stays there). */
  listTemplates: () => Promise<TemplateListResponse>;
  getTemplate: (id: string) => Promise<TemplateDetailView>;
  /**
   * A template id to open on arrival — a `sapiom://templates/<id>` deep link,
   * routed here by App. Resolved against the live catalog (and bundled starters)
   * once they load; an unknown id falls through to the gallery. Applied only when
   * the id changes, so the user can navigate back afterwards without being yanked
   * forward again.
   */
  openTemplateId?: string | null;
}

/**
 * Start from a template — a destination, not a dialog.
 *
 * This surface has to hold a search field, two filter axes, a card grid, and a
 * full write-up of whichever template you open. A modal can host a decision;
 * it cannot host that, and trying meant browsing the catalog through a
 * letterbox. So it became a place the shell navigates to (rail nav row in,
 * back button out) and stands in for the workbench while you are there.
 *
 * Three properties are load-bearing and easy to lose in a redesign:
 *
 * 1. **The catalog is fetched, never bundled.** A hardcoded copy is why the
 *    Studio once offered only two templates while the dashboard had the full catalog.
 * 2. **A degraded fetch says so.** Signed out or core unreachable, the notice
 *    names the reason. Silence is what let a short list read as a whole catalog.
 * 3. **Bundled starters keep their own block.** They do not require the live
 *    gallery or a Sapiom account, and they are not catalog entries. They
 *    declare no category or trigger, and inventing one to tidy the grid would
 *    be fabricating registry data.
 *
 * There is no result-count line above the grid: every facet row already carries
 * its own count, and the hero states the total.
 */
export function TemplatesPanel({
  projectRoot,
  recentDirs,
  listDir,
  onExit,
  onUse,
  listTemplates,
  getTemplate,
  openTemplateId,
}: TemplatesPanelProps): JSX.Element {
  const [catalog, setCatalog] = useState<TemplateListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TemplateFilter>(NO_FILTER);
  // Reading a template and committing to one are separate states: the detail
  // view is somewhere you browse, the dialog is the one question it can ask.
  const [opened, setOpened] = useState<StudioTemplate | null>(null);
  const [confirming, setConfirming] = useState<StudioTemplate | null>(null);
  const useTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    listTemplates()
      .then((response) => {
        if (!cancelled) setCatalog(response);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // Once per visit: the server caches the upstream call, so re-fetching on a
    // keystroke would be waste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gallery = useMemo<GalleryTemplate[]>(
    () =>
      (catalog?.templates ?? []).map((template) => ({
        ...template,
        kind: "gallery" as const,
      })),
    [catalog],
  );
  const results = useMemo(
    () => filterTemplates(gallery, filter, matchesQuery),
    [gallery, filter],
  );
  // Starters answer the query but not the facets: they declare neither axis, so
  // selecting a category or a trigger is a statement about the gallery, and
  // leaving them on screen under one would misrepresent them as matching it.
  const starters = useMemo(
    () =>
      filter.category !== null || filter.cadence !== null
        ? []
        : STARTER_TEMPLATES.filter((template) =>
            matchesQuery(template, filter.query),
          ),
    [filter],
  );

  // Open a deep-linked template's detail once it can be resolved. Keyed on the id
  // via a ref so navigating back (setOpened(null)) isn't undone on the next render,
  // while a later, different deep link still opens. Unknown/not-yet-loaded ids just
  // leave the gallery showing.
  const openedByDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openTemplateId || openedByDeepLinkRef.current === openTemplateId) return;
    const match =
      gallery.find((template) => template.id === openTemplateId) ??
      STARTER_TEMPLATES.find((template) => template.id === openTemplateId);
    if (!match) return;
    openedByDeepLinkRef.current = openTemplateId;
    setOpened(match);
  }, [openTemplateId, gallery]);

  const loading = catalog === null && loadError === null;

  /** Why the shelf is short, in the user's own terms. */
  const degraded = ((): string | null => {
    if (loadError) return `Could not load the template gallery: ${loadError}`;
    if (!catalog || catalog.source === "live") return null;
    return catalog.reason === "signed-out"
      ? "Sign in to Sapiom to browse the template gallery. The bundled starters below remain available."
      : "The template gallery is unreachable right now. The bundled starters below remain available.";
  })();

  // No `surface` on the panel itself. It hosts two mutually exclusive modes —
  // the grid and the opened detail — and an outer `surface` would win over the
  // detail's own, collapsing both into one indistinguishable bucket. Each mode
  // carries its own instead.
  return (
    <section
      className="templates-panel"
      data-testid="templates-panel"
      aria-label="Templates"
    >
      {/* Matches the session bar's height, so the shell's top edge does not
          shift as you enter and leave the browser. */}
      <div className="templates-bar" {...trackingAttrs({ surface: "template_gallery" })}>
        <button
          type="button"
          className="theme-toggle templates-back"
          data-testid={opened ? "template-detail-back" : "templates-exit"}
          aria-label={opened ? "Back to all templates" : "Back to the session"}
          title={opened ? "All templates" : "Back to the session"}
          onClick={() => (opened ? setOpened(null) : onExit())}
        >
          <Icon name="ArrowLeft" size={14} />
        </button>
        <span className="templates-bar-title">
          {opened ? opened.name : "Templates"}
        </span>
        {opened && (
          <button
            ref={useTriggerRef}
            type="button"
            className="btn-primary templates-bar-use"
            data-testid="template-use-btn"
            onClick={() => setConfirming(opened)}
          >
            Use template
          </button>
        )}
      </div>

      <div className="templates-scroll">
        <div className="templates-measure">
          {opened ? (
            <TemplateDetail template={opened} getTemplate={getTemplate} />
          ) : (
            <TrackScope surface="template_gallery">
              <header className="templates-hero">
                <h2 className="templates-hero-title">Start from a template</h2>
                <p className="templates-hero-copy">
                  {/* Counts what actually loaded, so a degraded catalog cannot
                      advertise templates that are not on screen. */}
                  {loading
                    ? "Loading the catalog…"
                    : `${gallery.length} runnable agents. Open one to read what it does, then use it. A session starts in a new folder and sets it up for you.`}
                </p>
              </header>

              {degraded && (
                <div
                  className="templates-degraded"
                  data-testid="templates-degraded"
                  role="status"
                >
                  <Icon name="TriangleAlert" size={14} />
                  <span>{degraded}</span>
                </div>
              )}

              <div className="templates-layout">
                <TemplateFilters
                  catalog={gallery}
                  filter={filter}
                  onChange={setFilter}
                />

                <div className="templates-results">
                  {results.length > 0 && (
                    <div
                      className="templates-grid"
                      data-testid="templates-grid"
                    >
                      {results.map((template) => (
                        <TemplateCard
                          key={template.id}
                          template={template}
                          onOpen={setOpened}
                          onUse={setConfirming}
                        />
                      ))}
                    </div>
                  )}

                  {results.length === 0 && !loading && gallery.length > 0 && (
                    <EmptyState
                      className="templates-empty"
                      testId="templates-empty"
                      icon="Search"
                      title="No template matches these filters"
                      body={`Search a tag or a capability, or clear the filters to see all ${gallery.length}.`}
                      cta={
                        isFiltered(filter) ? (
                          <button
                            type="button"
                            className="btn-line"
                            data-testid="templates-empty-clear"
                            onClick={() => setFilter(NO_FILTER)}
                          >
                            Clear filters
                          </button>
                        ) : undefined
                      }
                    />
                  )}

                  {starters.length > 0 && (
                    <section
                      className="templates-starters"
                      data-testid="templates-starters"
                    >
                      <span className="facet-title">Bundled starters</span>
                      <p className="templates-starters-copy">
                        Shipped with the CLI. No Sapiom account or capability
                        spend; setup may access npm.
                      </p>
                      <div className="templates-grid">
                        {starters.map((template) => (
                          <TemplateCard
                            key={template.id}
                            template={template}
                            onOpen={setOpened}
                            onUse={setConfirming}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </div>
            </TrackScope>
          )}
        </div>
      </div>

      {confirming && (
        <TemplateUseDialog
          template={confirming}
          initialDest={templateDirSuggestion(confirming, projectRoot)}
          recentDirs={recentDirs}
          listDir={listDir}
          onCancel={() => setConfirming(null)}
          triggerRef={useTriggerRef}
          onConfirm={async (destination) => {
            await onUse(destination, confirming);
            // The session that just started IS the destination — leaving the
            // browser mounted over it would bury the thing you asked for.
            onExit();
          }}
        />
      )}
    </section>
  );
}
