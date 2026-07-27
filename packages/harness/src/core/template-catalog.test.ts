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
      // Classified by the shared rule: lowest ordinal is the entry, the step
      // whose only outgoing edge is `terminate` is a success exit.
      expect(detail?.steps.map((s) => s.kind)).toEqual(["entry", "terminal-success"]);
      expect(detail?.steps.map((s) => s.sublabel)).toEqual(["entry", "terminal · success"]);
      // Ids resolve to names, and the terminate SINK is not a drawn edge.
      expect(detail?.transitions).toEqual([
        { from: "search", to: "summarize", label: null, kind: "continue" },
      ]);
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
          // `gate` is deliberately NOT the entry: entry outranks pause in the
          // precedence, so a pause on the ordinal-0 step would classify as
          // `entry` and this assertion would prove nothing.
          steps: [
            { id: "t::request", stepName: "request", ordinal: 0, kind: "compute", capabilityId: null },
            { id: "t::gate", stepName: "gate", ordinal: 1, kind: "compute", capabilityId: null },
            { id: "t::approved", stepName: "approved", ordinal: 2, kind: "compute", capabilityId: null },
          ],
          transitions: [
            {
              id: "t::request->t::gate",
              fromStepDefinitionId: "t::request",
              toStepDefinitionId: "t::gate",
              kind: "continue",
              signal: null,
              ordinal: 0,
            },
            {
              id: "t::gate->t::approved",
              fromStepDefinitionId: "t::gate",
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
        { from: "request", to: "gate", label: null, kind: "continue" },
        { from: "gate", to: "approved", label: "approval.granted", kind: "pause" },
      ]);
      // The step that HOLDS the pause is the pause node — the canvas draws it
      // dashed and labels it with the signal.
      expect(detail?.steps[1].kind).toBe("pause");
      expect(detail?.steps[1].sublabel).toBe("pause · approval.granted");
    });

    it("a fail-only sink is terminal-WARN, not a green success exit", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          ...upstreamSummary(),
          steps: [
            { id: "t::run", stepName: "run", ordinal: 0, kind: "compute", capabilityId: null },
            { id: "t::check", stepName: "check", ordinal: 1, kind: "compute", capabilityId: null },
          ],
          transitions: [
            {
              id: "t::run->t::check",
              fromStepDefinitionId: "t::run",
              toStepDefinitionId: "t::check",
              kind: "continue",
              signal: null,
              ordinal: 0,
            },
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

      // The collapse this replaced rendered `check` as terminal-success (green),
      // asserting a clean finish for a step that only ever fails out.
      expect(detail?.steps[1].kind).toBe("terminal-warn");
      expect(detail?.steps[1].sublabel).toBe("terminal · needs attention");
      // The sink itself has no target, so it is not a drawn edge.
      expect(detail?.transitions.map((t) => t.to)).toEqual(["check"]);
    });

    it("a step that can continue AND terminate stays a mid-flow step, not an exit", async () => {
      // The gate shape: continues on approval, terminates on rejection. Marking
      // it terminal drew an exit chip on a node that still has successors.
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          ...upstreamSummary(),
          steps: [
            { id: "t::decide", stepName: "decide", ordinal: 0, kind: "compute", capabilityId: null },
            { id: "t::proceed", stepName: "proceed", ordinal: 1, kind: "compute", capabilityId: null },
          ],
          transitions: [
            {
              id: "t::decide->t::proceed",
              fromStepDefinitionId: "t::decide",
              toStepDefinitionId: "t::proceed",
              kind: "continue",
              signal: null,
              ordinal: 0,
            },
            {
              id: "t::decide::terminate",
              fromStepDefinitionId: "t::decide",
              toStepDefinitionId: null,
              kind: "terminate",
              signal: null,
              ordinal: 1,
            },
          ],
        }),
      );
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      const detail = await catalog.detail("t");

      // `decide` is the entry here (lowest ordinal), which outranks everything.
      expect(detail?.steps[0].kind).toBe("entry");
      // `proceed` has no outgoing edges at all — a plain step, not an exit.
      expect(detail?.steps[1].kind).toBe("step");
    });

    it("classifies a non-entry continue+terminate gate as a step", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          ...upstreamSummary(),
          steps: [
            { id: "t::start", stepName: "start", ordinal: 0, kind: "compute", capabilityId: null },
            { id: "t::gate", stepName: "gate", ordinal: 1, kind: "compute", capabilityId: null },
            { id: "t::done", stepName: "done", ordinal: 2, kind: "compute", capabilityId: null },
          ],
          transitions: [
            { id: "e1", fromStepDefinitionId: "t::start", toStepDefinitionId: "t::gate", kind: "continue", signal: null, ordinal: 0 },
            { id: "e2", fromStepDefinitionId: "t::gate", toStepDefinitionId: "t::done", kind: "continue", signal: null, ordinal: 0 },
            { id: "e3", fromStepDefinitionId: "t::gate", toStepDefinitionId: null, kind: "terminate", signal: null, ordinal: 1 },
            { id: "e4", fromStepDefinitionId: "t::done", toStepDefinitionId: null, kind: "terminate", signal: null, ordinal: 0 },
          ],
        }),
      );
      const catalog = createTemplateCatalog({ apiKey: "sk_test", baseUrl: BASE, fetchImpl });

      const detail = await catalog.detail("t");

      expect(detail?.steps.map((s) => `${s.name}:${s.kind}`)).toEqual([
        "start:entry",
        "gate:step",
        "done:terminal-success",
      ]);
      expect(detail?.steps[1].sublabel).toBe("step · can also terminate");
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
