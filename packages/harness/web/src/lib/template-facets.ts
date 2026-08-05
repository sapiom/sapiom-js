/**
 * The template browser's two facet axes, derived from the LIVE catalog.
 *
 * The design prototype computed these from a static `TEMPLATES` array bundled
 * into a design-system package. The Studio has no such array and must not grow
 * one — a local copy of the catalog is the exact bug `lib/templates.ts` was
 * written to kill. So facets are derived from whatever `GET /api/templates`
 * actually returned, which also means they degrade correctly: an unreachable
 * catalog yields no facets rather than a sidebar advertising templates that
 * are not on screen.
 *
 * The two axes are the registry's own, from `examples/registry.schema.json`:
 *
 * - `category` — the OUTCOME axis ("what am I trying to produce?"), a 7-value
 *   enum. Mechanism words live in freeform `tags`, which is why tags are not a
 *   third facet list: there are dozens, they would swamp the column, and
 *   `matchesQuery` already searches them so typing one finds its templates.
 * - `cadence` — what STARTS a run, a 4-value enum, surfaced as "Trigger"
 *   because that is what it means to someone choosing a template.
 *
 * Both are `string | null` in `TemplateSummary` rather than unions, deliberately:
 * the taxonomy is owned upstream, so an id this build has never heard of has to
 * bucket rather than drop the card. Unrecognised ids therefore become facets of
 * their own (humanized by `categoryLabel`), and undeclared ones collect under a
 * single trailing bucket. A card is always reachable through some facet.
 */

import { categoryLabel, type GalleryTemplate } from "./templates";

/**
 * Facet value standing for "declared nothing on this axis".
 *
 * Not `null`: the filter already uses `null` for "no filter applied", and a
 * facet row has to be able to mean "only the ones with nothing declared". The
 * schema's ids are lowercase kebab-case, so parentheses cannot collide with a
 * real id.
 */
export const UNDECLARED = "(none)";

export interface Facet {
  /** The `category`/`cadence` id, or UNDECLARED. */
  value: string;
  label: string;
  count: number;
}

export interface TemplateFilter {
  query: string;
  /** null = every category. */
  category: string | null;
  /** null = every trigger. */
  cadence: string | null;
}

export const NO_FILTER: TemplateFilter = {
  query: "",
  category: null,
  cadence: null,
};

export function isFiltered(filter: TemplateFilter): boolean {
  return (
    filter.query.trim() !== "" ||
    filter.category !== null ||
    filter.cadence !== null
  );
}

/**
 * Trigger labels for the registry's `cadence` enum. "Webhook" rather than
 * "On webhook" — the axis title already supplies "trigger", so the value only
 * has to name the thing that fires it.
 */
const CADENCE_LABELS: Record<string, string> = {
  "on-demand": "On demand",
  scheduled: "Scheduled",
  "on-event": "On event",
  "on-webhook": "Webhook",
};

export function cadenceLabel(cadence: string | null): string {
  if (!cadence) return "No trigger declared";
  return (
    CADENCE_LABELS[cadence] ??
    cadence.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

/**
 * Count templates by one axis, drop the values nothing carries, and order by
 * count descending (label breaking ties) so the biggest shelves lead.
 *
 * Counts come from the WHOLE catalog, never the current result set: a row that
 * renumbers or vanishes under the cursor about to click it makes the column
 * unusable. The undeclared bucket always sorts last regardless of its count —
 * it is an absence, not a category, and should not lead the list.
 */
function facetsOf(
  templates: GalleryTemplate[],
  axis: (template: GalleryTemplate) => string | null,
  label: (value: string) => string,
): Facet[] {
  const counts = new Map<string, number>();
  for (const template of templates) {
    const value = axis(template) ?? UNDECLARED;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => {
      if (a.value === UNDECLARED) return 1;
      if (b.value === UNDECLARED) return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}

export function categoryFacets(templates: GalleryTemplate[]): Facet[] {
  return facetsOf(
    templates,
    (template) => template.category,
    (value) => (value === UNDECLARED ? "Uncategorised" : categoryLabel(value)),
  );
}

export function cadenceFacets(templates: GalleryTemplate[]): Facet[] {
  return facetsOf(
    templates,
    (template) => template.cadence,
    (value) =>
      value === UNDECLARED ? "No trigger declared" : cadenceLabel(value),
  );
}

/** Does this template sit in the selected facet? UNDECLARED selects the
 *  templates that declared nothing on that axis. */
function onAxis(declared: string | null, selected: string | null): boolean {
  if (selected === null) return true;
  if (selected === UNDECLARED) return declared === null;
  return declared === selected;
}

/**
 * Apply the filter. Query matching is delegated to `matchesQuery` so the
 * browser searches exactly what the rest of the Studio searches (name,
 * description, id, tags, capabilities) — one definition of "matches", not two.
 */
export function filterTemplates(
  templates: GalleryTemplate[],
  filter: TemplateFilter,
  matches: (template: GalleryTemplate, query: string) => boolean,
): GalleryTemplate[] {
  return templates.filter(
    (template) =>
      matches(template, filter.query) &&
      onAxis(template.category, filter.category) &&
      onAxis(template.cadence, filter.cadence),
  );
}
