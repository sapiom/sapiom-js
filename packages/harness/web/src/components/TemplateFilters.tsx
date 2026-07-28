import type { JSX } from "react";

import { cadenceFacets, categoryFacets, type TemplateFilter } from "../lib/template-facets";
import type { GalleryTemplate } from "../lib/templates";
import { FacetList } from "./FacetList";
import { Icon } from "./Icon";

/**
 * How you narrow the catalog: a search field, then the two axes the registry
 * actually discriminates on — what a template produces (`category`) and what
 * starts it (`cadence`, shown as "Trigger" because that is what it means to
 * someone choosing).
 *
 * Tags are not a third axis on purpose. There are dozens of them, they would
 * swamp this column, and search already covers them — so typing a tag finds its
 * templates without the column having to list every one.
 *
 * Counts describe the WHOLE catalog rather than the current results, so a row
 * never renumbers or disappears under the cursor about to click it. The facet
 * helpers drop the values no template carries, so nothing advertises an empty
 * shelf.
 */
export function TemplateFilters({
  catalog,
  filter,
  onChange,
}: {
  /** Everything the fetch returned — the population the counts are of. */
  catalog: GalleryTemplate[];
  filter: TemplateFilter;
  onChange: (next: TemplateFilter) => void;
}): JSX.Element {
  return (
    <div className="template-filters" data-testid="template-filters">
      {/* A real input, not a handoff to the command palette: the palette indexes
          sessions, workflows and paths, so sending someone there to find a
          template would send them somewhere that cannot answer. */}
      <div className="template-search">
        <Icon name="Search" size={14} />
        <input
          className="template-search-input"
          type="search"
          value={filter.query}
          placeholder="Search templates"
          aria-label="Search templates"
          data-testid="template-search"
          onChange={(event) => onChange({ ...filter, query: event.target.value })}
        />
      </div>

      <FacetList
        title="Category"
        allLabel="All templates"
        allCount={catalog.length}
        options={categoryFacets(catalog)}
        value={filter.category}
        onSelect={(category) => onChange({ ...filter, category })}
        testIdPrefix="templates-category"
      />

      <FacetList
        title="Trigger"
        allLabel="Any trigger"
        allCount={catalog.length}
        options={cadenceFacets(catalog)}
        value={filter.cadence}
        onSelect={(cadence) => onChange({ ...filter, cadence })}
        testIdPrefix="templates-cadence"
      />
    </div>
  );
}
