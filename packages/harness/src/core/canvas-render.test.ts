import { describe, expect, it, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CANVAS_DIR } from "../shared/types.js";
import { clearExtractionCache, fingerprintWorkflowSources } from "./canvas-cache.js";
import { writeEnrichmentCacheFile } from "./canvas-enrichment.js";
import {
  enrichmentCacheFileFor,
  renderCanvasForSession,
  renderFileFor,
  slugForWorkflowPath,
  type RenderableWorkflow,
} from "./canvas-render.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ORDER_TRIAGE = path.join(FIXTURES_DIR, "order-triage");
const NO_DEFINITION = path.join(FIXTURES_DIR, "no-definition");
const HUB = path.join(FIXTURES_DIR, "hub");
const LEGACY_FLOW = path.join(FIXTURES_DIR, "legacy-flow");

const tmpDirs: string[] = [];
async function tmpCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-render-test-"));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => clearExtractionCache());
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function readRender(cwd: string, workflowPath: string): Promise<string> {
  return fs.readFile(renderFileFor(cwd, workflowPath), "utf8");
}

describe("slugForWorkflowPath", () => {
  it("is readable, filesystem-safe and collision-proof across same-named workflows", () => {
    const a = slugForWorkflowPath("/projects/a/order-triage");
    const b = slugForWorkflowPath("/projects/b/order-triage");
    expect(a).toMatch(/^order-triage-[0-9a-f]{8}$/);
    expect(b).toMatch(/^order-triage-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(slugForWorkflowPath("/projects/a/order-triage")).toBe(a); // deterministic
  });
});

describe("renderCanvasForSession", () => {
  it("renders the bound workflow's real step names into its own per-workflow render file — index.html is never touched", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, workflows);

    expect(outcome.mode).toBe("single");
    expect(outcome.workflowPath).toBe(ORDER_TRIAGE);
    expect(outcome.extractionFailed).toEqual([]);
    expect(outcome.cachedExtraction).toBe(false);
    expect(outcome.renderPath).toBe(renderFileFor(cwd, ORDER_TRIAGE));

    const html = await readRender(cwd, ORDER_TRIAGE);
    for (const step of ["intake", "classify", "route", "auto_resolve", "escalate"]) {
      expect(html).toContain(`>${step}<`);
    }
    expect(html).toContain("canvas-legend");

    await expect(fs.access(path.join(cwd, CANVAS_DIR, "index.html"))).rejects.toThrow();
  });

  it("serves the second render of an unchanged workflow from the extraction cache", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];
    await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, workflows);
    const second = await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, workflows);
    expect(second.cachedExtraction).toBe(true);
    await expect(readRender(cwd, ORDER_TRIAGE)).resolves.toContain(">intake<");
  });

  it("renders an old-SDK (legacy-branded) workflow — the dual-brand extraction end to end", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: LEGACY_FLOW, name: "legacy-flow", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: LEGACY_FLOW }, workflows);

    expect(outcome.extractionFailed).toEqual([]);
    const html = await readRender(cwd, LEGACY_FLOW);
    for (const step of ["receive", "confirm", "award"]) expect(html).toContain(`>${step}<`);
  });

  it("includes detected launches as dashed launched-workflow nodes in the bound workflow's own diagram", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: HUB, name: "hub", definitionId: null }];
    await renderCanvasForSession({ cwd, boundWorkflowPath: HUB }, workflows);

    const html = await readRender(cwd, HUB);
    expect(html).toContain("node--launched-workflow");
    expect(html).toContain(">spoke-workflow<");
    expect(html).toContain("canvas-edge--launch");
    expect(html).toContain(">launch()<");
  });

  it("degrades to an honest error panel when the bound workflow fails to extract — never crashes, never falls back to an LLM prompt", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: NO_DEFINITION }, workflows);

    expect(outcome.mode).toBe("single");
    expect(outcome.extractionFailed).toEqual(["broken-flow"]);
    const html = await readRender(cwd, NO_DEFINITION);
    expect(html).toContain("broken-flow");
    expect(html).toContain("render failed");
    expect(html).toContain("Could not extract this workflow's step graph");
    expect(html).not.toContain('class="canvas-node '); // no diagram — just the note
  });

  it("is a cheap no-op when unbound: no extraction, no write — the server serves the empty state itself", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows);

    expect(outcome).toEqual({ mode: "empty", extractionFailed: [] });
    await expect(fs.access(path.join(cwd, CANVAS_DIR))).rejects.toThrow(); // nothing written at all
  });

  it("treats a boundWorkflowPath that matches no known workflow as unbound", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: "/no/such/workflow" }, workflows);
    expect(outcome.mode).toBe("empty");
  });

  it("never throws when the cwd is unwritable — reports writeError instead", async () => {
    // A file, not a directory, as the "cwd" — mkdir underneath it must fail.
    const parent = await tmpCwd();
    const notADir = path.join(parent, "not-a-directory");
    await fs.writeFile(notADir, "x");

    const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd: notADir, boundWorkflowPath: ORDER_TRIAGE }, workflows);
    expect(outcome.mode).toBe("single");
    expect(outcome.writeError).toBeTruthy();
  });

  describe("preserveExistingOnFailure (unprompted auto-renders)", () => {
    const GOOD_RENDER = "<!doctype html><!-- previously good diagram -->";

    it("keeps this workflow's existing render when extraction failed, instead of replacing it with an error panel", async () => {
      const cwd = await tmpCwd();
      const renderPath = renderFileFor(cwd, NO_DEFINITION);
      await fs.mkdir(path.dirname(renderPath), { recursive: true });
      await fs.writeFile(renderPath, GOOD_RENDER, "utf8");
      const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];

      const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: NO_DEFINITION }, workflows, {
        preserveExistingOnFailure: true,
      });

      expect(outcome.extractionFailed).toEqual(["broken-flow"]);
      expect(outcome.preservedExisting).toBe(true);
      expect(await readRender(cwd, NO_DEFINITION)).toBe(GOOD_RENDER);
    });

    it("still writes the honest error page when nothing exists to preserve", async () => {
      const cwd = await tmpCwd();
      const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];

      const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: NO_DEFINITION }, workflows, {
        preserveExistingOnFailure: true,
      });

      expect(outcome.preservedExisting).toBeUndefined();
      expect(await readRender(cwd, NO_DEFINITION)).toContain("render failed");
    });

    it("does not change explicit-render behavior: without the option, the error panel replaces the existing render", async () => {
      const cwd = await tmpCwd();
      const renderPath = renderFileFor(cwd, NO_DEFINITION);
      await fs.mkdir(path.dirname(renderPath), { recursive: true });
      await fs.writeFile(renderPath, GOOD_RENDER, "utf8");
      const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];

      const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: NO_DEFINITION }, workflows);

      expect(outcome.preservedExisting).toBeUndefined();
      expect(await readRender(cwd, NO_DEFINITION)).toContain("render failed");
    });
  });
});

describe("enrichment merge in renders", () => {
  const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];

  async function seedEnrichmentCache(cwd: string, sourceFingerprint: string): Promise<void> {
    await writeEnrichmentCacheFile(enrichmentCacheFileFor(cwd, ORDER_TRIAGE), {
      graph: { manifestName: "order-triage", entry: "intake", warnings: [], nodes: [], edges: [] },
      enrichment: {
        summary: "Triage incoming orders and route them",
        nodeDetails: { intake: { sublabel: "receives the order" } },
        notes: ["Orders above $10k always escalate"],
        crossWorkflow: "Escalations hand off to the support workflow",
      },
      sourceFingerprint,
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  it("merges a FRESH cached enrichment into the render — summary, sublabels, footer notes, no stale chip", async () => {
    const cwd = await tmpCwd();
    await seedEnrichmentCache(cwd, await fingerprintWorkflowSources(ORDER_TRIAGE));

    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, workflows);
    expect(outcome.enrichmentApplied).toBe(true);
    expect(outcome.enrichmentStale).toBe(false);

    const html = await readRender(cwd, ORDER_TRIAGE);
    expect(html).toContain("Triage incoming orders and route them");
    expect(html).toContain("receives the order");
    expect(html).toContain("Orders above $10k always escalate");
    expect(html).toContain("Escalations hand off to the support workflow");
    expect(html).not.toContain("stale — Refresh");
  });

  it("keeps a STALE enrichment displayed with the stale chip — the base structure is freshly extracted either way", async () => {
    const cwd = await tmpCwd();
    await seedEnrichmentCache(cwd, "0:0"); // never matches the real sources

    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, workflows);
    expect(outcome.enrichmentApplied).toBe(true);
    expect(outcome.enrichmentStale).toBe(true);

    const html = await readRender(cwd, ORDER_TRIAGE);
    expect(html).toContain("stale — Refresh");
    expect(html).toContain("Triage incoming orders and route them"); // kept, not dropped
    expect(html).toContain(">intake<"); // fresh base extraction still present
  });

  it("renders the plain base when no enrichment cache exists", async () => {
    const cwd = await tmpCwd();
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, workflows);
    expect(outcome.enrichmentApplied).toBeUndefined();
    const html = await readRender(cwd, ORDER_TRIAGE);
    expect(html).not.toContain("stale — Refresh");
    expect(html).toContain(">intake<");
  });

  it("ignores the enrichment cache entirely when extraction fails — the error panel carries no annotations", async () => {
    const cwd = await tmpCwd();
    await writeEnrichmentCacheFile(enrichmentCacheFileFor(cwd, NO_DEFINITION), {
      graph: { manifestName: "broken-flow", entry: "x", warnings: [], nodes: [], edges: [] },
      enrichment: { summary: "should never appear on an error panel" },
      sourceFingerprint: "any",
      enrichedAt: "2026-01-01T00:00:00.000Z",
    });
    const broken: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];

    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: NO_DEFINITION }, broken);
    expect(outcome.enrichmentApplied).toBeUndefined();
    const html = await readRender(cwd, NO_DEFINITION);
    expect(html).toContain("render failed");
    expect(html).not.toContain("should never appear");
  });
});
