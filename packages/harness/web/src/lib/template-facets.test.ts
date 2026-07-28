/**
 * Unit coverage for the template browser's facet axes. The interesting
 * properties are all about NOT losing a card: an unrecognised category id, an
 * undeclared one, and an empty catalog each have a defined outcome.
 */
import { describe, expect, it } from "vitest";
import type { TemplateSummary } from "@shared/types";

import {
  NO_FILTER,
  UNDECLARED,
  cadenceFacets,
  cadenceLabel,
  categoryFacets,
  filterTemplates,
  isFiltered,
} from "./template-facets";
import { matchesQuery, type GalleryTemplate } from "./templates";

const template = (overrides: Partial<TemplateSummary>): GalleryTemplate => ({
  kind: "gallery",
  id: "t1",
  name: "Template One",
  description: "Does a thing.",
  tags: [],
  category: "revenue-marketing",
  cadence: "on-demand",
  stepCount: 3,
  capabilities: [],
  // Null is the honest default: a response predating the band, which the UI
  // renders as an em dash rather than inventing a score.
  complexity: null,
  ...overrides,
});

describe("categoryFacets", () => {
  it("counts each category and orders by size, biggest shelf first", () => {
    const facets = categoryFacets([
      template({ id: "a", category: "data-knowledge" }),
      template({ id: "b", category: "revenue-marketing" }),
      template({ id: "c", category: "revenue-marketing" }),
      template({ id: "d", category: "starter" }),
      template({ id: "e", category: "revenue-marketing" }),
      template({ id: "f", category: "data-knowledge" }),
    ]);

    expect(facets.map((f) => [f.value, f.count])).toEqual([
      ["revenue-marketing", 3],
      ["data-knowledge", 2],
      ["starter", 1],
    ]);
  });

  it("omits categories no template carries, rather than listing empty shelves", () => {
    const facets = categoryFacets([template({ category: "starter" })]);

    expect(facets).toHaveLength(1);
    expect(facets[0]?.value).toBe("starter");
  });

  it("keeps an unrecognised category as its own facet, humanized", () => {
    // The taxonomy is owned upstream: a new id must bucket, never drop the card.
    const facets = categoryFacets([template({ category: "wild-new-axis" })]);

    expect(facets[0]).toMatchObject({ value: "wild-new-axis", label: "Wild new axis", count: 1 });
  });

  it("collects undeclared categories into a trailing bucket", () => {
    const facets = categoryFacets([
      template({ id: "a", category: null }),
      template({ id: "b", category: null }),
      template({ id: "c", category: null }),
      template({ id: "d", category: "starter" }),
    ]);

    // Last despite outnumbering: an absence is not a category and must not lead.
    expect(facets.map((f) => f.value)).toEqual(["starter", UNDECLARED]);
    expect(facets[1]).toMatchObject({ label: "Uncategorised", count: 3 });
  });

  it("returns nothing for an empty catalog, so a degraded fetch shows no facets", () => {
    expect(categoryFacets([])).toEqual([]);
  });

  it("breaks equal counts on label so the column never reshuffles", () => {
    const facets = categoryFacets([
      template({ id: "a", category: "starter" }),
      template({ id: "b", category: "data-knowledge" }),
    ]);

    // "Data and knowledge" before "Starter".
    expect(facets.map((f) => f.value)).toEqual(["data-knowledge", "starter"]);
  });
});

describe("cadenceFacets", () => {
  it("labels the registry's cadence enum in trigger terms", () => {
    expect(cadenceLabel("on-demand")).toBe("On demand");
    expect(cadenceLabel("scheduled")).toBe("Scheduled");
    expect(cadenceLabel("on-event")).toBe("On event");
    // The axis title already says "trigger", so the value needn't repeat it.
    expect(cadenceLabel("on-webhook")).toBe("Webhook");
  });

  it("humanizes an unrecognised cadence instead of dropping it", () => {
    const facets = cadenceFacets([template({ cadence: "on-heartbeat" })]);

    expect(facets[0]).toMatchObject({ value: "on-heartbeat", label: "On heartbeat" });
  });

  it("counts undeclared triggers under one trailing bucket", () => {
    const facets = cadenceFacets([
      template({ id: "a", cadence: null }),
      template({ id: "b", cadence: "scheduled" }),
    ]);

    expect(facets.map((f) => [f.value, f.label])).toEqual([
      ["scheduled", "Scheduled"],
      [UNDECLARED, "No trigger declared"],
    ]);
  });
});

describe("filterTemplates", () => {
  const catalog = [
    template({ id: "outreach", name: "Cold Outreach", category: "revenue-marketing", cadence: "on-demand", tags: ["sales", "drip"] }),
    template({ id: "digest", name: "Error Digest", category: "reliability-governance", cadence: "scheduled", tags: ["errors"] }),
    template({ id: "loose", name: "Loose End", category: null, cadence: null }),
  ];

  it("passes everything through when nothing is selected", () => {
    expect(filterTemplates(catalog, NO_FILTER, matchesQuery)).toHaveLength(3);
  });

  it("narrows by category", () => {
    const result = filterTemplates(catalog, { ...NO_FILTER, category: "revenue-marketing" }, matchesQuery);

    expect(result.map((t) => t.id)).toEqual(["outreach"]);
  });

  it("narrows by trigger", () => {
    const result = filterTemplates(catalog, { ...NO_FILTER, cadence: "scheduled" }, matchesQuery);

    expect(result.map((t) => t.id)).toEqual(["digest"]);
  });

  it("intersects the two axes", () => {
    const result = filterTemplates(
      catalog,
      { ...NO_FILTER, category: "revenue-marketing", cadence: "scheduled" },
      matchesQuery,
    );

    expect(result).toEqual([]);
  });

  it("selects the undeclared bucket on either axis", () => {
    expect(
      filterTemplates(catalog, { ...NO_FILTER, category: UNDECLARED }, matchesQuery).map((t) => t.id),
    ).toEqual(["loose"]);
    expect(
      filterTemplates(catalog, { ...NO_FILTER, cadence: UNDECLARED }, matchesQuery).map((t) => t.id),
    ).toEqual(["loose"]);
  });

  it("searches tags through the shared matcher, so a tag query finds its card", () => {
    // Tags are not a facet list precisely because search covers them.
    const result = filterTemplates(catalog, { ...NO_FILTER, query: "drip" }, matchesQuery);

    expect(result.map((t) => t.id)).toEqual(["outreach"]);
  });

  it("combines a query with a facet", () => {
    const result = filterTemplates(
      catalog,
      { ...NO_FILTER, query: "error", cadence: "scheduled" },
      matchesQuery,
    );

    expect(result.map((t) => t.id)).toEqual(["digest"]);
  });
});

describe("isFiltered", () => {
  it("is false at rest and true for any axis or a non-blank query", () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, query: "   " })).toBe(false);
    expect(isFiltered({ ...NO_FILTER, query: "x" })).toBe(true);
    expect(isFiltered({ ...NO_FILTER, category: "starter" })).toBe(true);
    expect(isFiltered({ ...NO_FILTER, cadence: "scheduled" })).toBe(true);
  });
});
