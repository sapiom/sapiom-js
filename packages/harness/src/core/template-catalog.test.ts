import { describe, expect, it, vi } from "vitest";

import { createTemplateCatalog } from "./template-catalog.js";
import type { ApiKeyProvider } from "./api-key-provider.js";

const BASE = "http://localhost:3000";

/** A summary as core's `GET /v1/workflows/templates` serves it. */
function upstreamSummary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "web-research-digest",
    name: "Web Research Digest",
    description: "Search the web and return a sourced digest.",
    tags: ["research"],
    category: "data-knowledge",
    cadence: "on-demand",
    stepCount: 2,
    capabilities: ["web.search"],
    estCostPerRunUsd: 0.006,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A provider whose key can change, so refresh-on-401 is observable. */
function provider(keys: Array<string | null>): ApiKeyProvider & { refreshCalls: number } {
  let index = 0;
  const state = {
    refreshCalls: 0,
    getKey: () => keys[Math.min(index, keys.length - 1)],
    refresh: async () => {
      state.refreshCalls += 1;
      index += 1;
      return keys[Math.min(index, keys.length - 1)];
    },
    setKey: () => {},
  };
  return state as unknown as ApiKeyProvider & { refreshCalls: number };
}

describe("createTemplateCatalog", () => {
  it("calls the CORE surface at the /v1 prefix with a Bearer token", async () => {
    // Both halves are contracts verified against a real backend: the core
    // surface rejects the `x-sapiom-api-key` header the AGENTS surface takes,
    // and a bare `/workflows/templates` (no /v1) 404s.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([upstreamSummary()]));
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    await catalog.list();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/workflows/templates`);
    expect(init.headers).toEqual({ Authorization: "Bearer sk_test" });
  });

  it("returns the live catalog, preserving every template", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([upstreamSummary(), upstreamSummary({ id: "hello-agent", name: "Hello Agent" })]),
      );
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    const result = await catalog.list();

    expect(result.source).toBe("live");
    expect(result.templates.map((t) => t.id)).toEqual(["web-research-digest", "hello-agent"]);
  });

  it("reports signed-out without calling upstream (an expected state, not a fault)", async () => {
    const fetchImpl = vi.fn();
    const catalog = createTemplateCatalog({ apiKey: null, baseUrl: BASE, fetchImpl });

    const result = await catalog.list();

    expect(result).toEqual({ templates: [], source: "fallback", reason: "signed-out" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("degrades to fallback (never throws) when core is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    await expect(catalog.list()).resolves.toEqual({
      templates: [],
      source: "fallback",
      reason: "unreachable",
    });
  });

  it("refreshes the key once and retries on a 401", async () => {
    const keys = provider(["sk_stale", "sk_fresh"]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse([upstreamSummary()]));
    const catalog = createTemplateCatalog({ apiKey: keys, baseUrl: BASE, fetchImpl });

    const result = await catalog.list();

    expect(result.source).toBe("live");
    expect(keys.refreshCalls).toBe(1);
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(secondInit.headers).toEqual({ Authorization: "Bearer sk_fresh" });
  });

  it("does not retry when refresh yields the same key (no infinite recovery loop)", async () => {
    const keys = provider(["sk_same", "sk_same"]);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "Unauthorized" }, 401));
    const catalog = createTemplateCatalog({ apiKey: keys, baseUrl: BASE, fetchImpl });

    const result = await catalog.list();

    expect(result.source).toBe("fallback");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches a successful list so reopening the dialog costs no round-trip", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([upstreamSummary()]));
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    await catalog.list();
    await catalog.list();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a template whose category is unknown or absent (the taxonomy is upstream)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([upstreamSummary({ category: "brand-new-axis" }), upstreamSummary({ id: "b", category: null })]),
      );
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    const result = await catalog.list();

    expect(result.templates.map((t) => t.category)).toEqual(["brand-new-axis", null]);
  });

  it("normalizes a missing cost estimate to null, never 0", async () => {
    // The majority case upstream. A 0 here would render as "$0" — a claim that
    // the run is free, which is different from "we have no estimate".
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse([upstreamSummary({ estCostPerRunUsd: undefined })]));
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    const result = await catalog.list();

    expect(result.templates[0].estCostPerRunUsd).toBeNull();
  });

  it("drops an entry with no id rather than rendering a card that cannot be cloned", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([upstreamSummary(), { name: "Nameless" }]));
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    const result = await catalog.list();

    expect(result.templates.map((t) => t.id)).toEqual(["web-research-digest"]);
  });

  it("survives a non-array body (a proxy's HTML error page, say)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "nope" }));
    const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

    await expect(catalog.list()).resolves.toMatchObject({ source: "fallback" });
  });

  describe("detail", () => {
    it("merges the manifest's rich fields with the top-level graph", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          ...upstreamSummary(),
          whatItDoes: "Searches, then summarizes.",
          sourcePath: "examples/web-research-digest",
          // The ENGINE's projection, verbatim from a real backend: stepName (not
          // name), a singular capabilityId, namespaced ids, and terminality
          // carried by a `terminate` edge rather than a flag on the step.
          steps: [
            { id: "wrd::search", stepName: "search", ordinal: 0, kind: "capability", capabilityId: "web.search" },
            { id: "wrd::summarize", stepName: "summarize", ordinal: 1, kind: "compute", capabilityId: null },
          ],
          transitions: [
            {
              id: "wrd::search->wrd::summarize",
              fromStepDefinitionId: "wrd::search",
              toStepDefinitionId: "wrd::summarize",
              kind: "continue",
              signal: null,
              ordinal: 0,
            },
            {
              id: "wrd::summarize::terminate",
              fromStepDefinitionId: "wrd::summarize",
              toStepDefinitionId: null,
              kind: "terminate",
              signal: null,
              ordinal: 0,
            },
          ],
          manifest: {
            author: { name: "Sapiom", url: "https://sapiom.ai/" },
            useCases: ["Brief yourself before a meeting."],
            notes: "Some **markdown**.",
            examples: [{ title: "Basic", input: { topic: "x" }, output: { digest: "y" } }],
            requiredSecrets: [{ key: "API_TOKEN", label: "API token", description: null }],
          },
        }),
      );
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      const detail = await catalog.detail("web-research-digest");

      expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/v1/workflows/templates/web-research-digest`);
      expect(detail?.whatItDoes).toBe("Searches, then summarizes.");
      expect(detail?.steps.map((s) => s.name)).toEqual(["search", "summarize"]);
      // capabilityId → the view's list; terminate edge → the step's flag.
      expect(detail?.steps[0].capabilities).toEqual(["web.search"]);
      expect(detail?.steps.map((s) => s.terminal)).toEqual([false, true]);
      // Ids resolve to names, and the terminate SINK is not a drawn edge.
      expect(detail?.transitions).toEqual([{ from: "search", to: "summarize", label: null }]);
      expect(detail?.author).toEqual({ name: "Sapiom", url: "https://sapiom.ai/" });
      expect(detail?.useCases).toEqual(["Brief yourself before a meeting."]);
      expect(detail?.requiredSecrets).toEqual([
        { key: "API_TOKEN", label: "API token", description: null },
      ]);
    });

    it("tolerates a template that ships no manifest at all", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...upstreamSummary(), steps: [], transitions: [] }));
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      const detail = await catalog.detail("web-research-digest");

      expect(detail?.author).toBeNull();
      expect(detail?.useCases).toEqual([]);
      expect(detail?.examples).toEqual([]);
      expect(detail?.notes).toBeNull();
    });

    it("labels a pause edge with the signal it waits for, and invents nothing else", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          ...upstreamSummary(),
          steps: [
            { id: "t::request", stepName: "request", ordinal: 0, kind: "compute", capabilityId: null },
            { id: "t::approved", stepName: "approved", ordinal: 1, kind: "compute", capabilityId: null },
          ],
          transitions: [
            {
              id: "t::request->t::approved",
              fromStepDefinitionId: "t::request",
              toStepDefinitionId: "t::approved",
              kind: "pause",
              signal: "approval.granted",
              ordinal: 0,
            },
          ],
        }),
      );
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      const detail = await catalog.detail("t");

      expect(detail?.transitions).toEqual([
        { from: "request", to: "approved", label: "approval.granted" },
      ]);
    });

    it("a fail sink marks its step terminal without becoming a drawn edge", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          ...upstreamSummary(),
          steps: [{ id: "t::check", stepName: "check", ordinal: 0, kind: "compute", capabilityId: null }],
          transitions: [
            {
              id: "t::check::fail",
              fromStepDefinitionId: "t::check",
              toStepDefinitionId: null,
              kind: "fail",
              signal: null,
              ordinal: 0,
            },
          ],
        }),
      );
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      const detail = await catalog.detail("t");

      expect(detail?.steps[0].terminal).toBe(true);
      expect(detail?.transitions).toEqual([]);
    });

    it("url-encodes the id", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...upstreamSummary(), id: "a/b" }));
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      await catalog.detail("a/b");

      expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/v1/workflows/templates/a%2Fb`);
    });

    it("returns null for an unknown id", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "Not found" }, 404));
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      await expect(catalog.detail("nope")).resolves.toBeNull();
    });
  });
});
