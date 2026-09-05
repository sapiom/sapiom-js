import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CANVAS_DIR } from "../shared/types.js";
import { clearExtractionCache } from "./canvas-cache.js";
import {
  deriveWorkflowCanvas,
  renderCanvasForSession,
  renderFileFor,
  slugForWorkflowPath,
  type RenderableWorkflow,
} from "./canvas-render.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);
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
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
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
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
    ];
    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );

    expect(outcome.mode).toBe("single");
    expect(outcome.workflowPath).toBe(ORDER_TRIAGE);
    expect(outcome.extractionFailed).toEqual([]);
    expect(outcome.cachedExtraction).toBe(false);
    expect(outcome.renderPath).toBe(renderFileFor(cwd, ORDER_TRIAGE));

    const html = await readRender(cwd, ORDER_TRIAGE);
    for (const step of [
      "intake",
      "classify",
      "route",
      "auto_resolve",
      "escalate",
    ]) {
      expect(html).toContain(`>${step}<`);
    }

    await expect(
      fs.access(path.join(cwd, CANVAS_DIR, "index.html")),
    ).rejects.toThrow();
  });

  it("embeds the step-graph JSON block the Steps tab reads — parseable, with the real nodes/edges", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
    ];
    await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );

    const html = await readRender(cwd, ORDER_TRIAGE);
    const match = html.match(
      /<script type="application\/json" id="sapiom-graph">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    // The escaped "<" keeps a "</script>" in any label from breaking out —
    // and it round-trips through JSON.parse back to real data.
    const graph = JSON.parse(match![1]) as {
      nodes: { id: string }[];
      edges: unknown[];
    };
    expect(graph.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(["intake", "classify", "route"]),
    );
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it("labels a definition link separately from a ready deployment", async () => {
    const linkedCwd = await tmpCwd();
    await renderCanvasForSession(
      { cwd: linkedCwd, boundWorkflowPath: ORDER_TRIAGE },
      [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: 42 }],
    );
    expect(await readRender(linkedCwd, ORDER_TRIAGE)).toContain(">linked<");

    const readyCwd = await tmpCwd();
    await renderCanvasForSession(
      { cwd: readyCwd, boundWorkflowPath: ORDER_TRIAGE },
      [
        {
          path: ORDER_TRIAGE,
          name: "order-triage",
          definitionId: 42,
          activeBuildRunStatus: "ready",
        },
      ],
    );
    expect(await readRender(readyCwd, ORDER_TRIAGE)).toContain(">deployed<");
  });

  it("serves the second render of an unchanged workflow from the extraction cache", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
    ];
    await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );
    const second = await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );
    expect(second.cachedExtraction).toBe(true);
    await expect(readRender(cwd, ORDER_TRIAGE)).resolves.toContain(">intake<");
  });

  it("writes nothing when unprompted launch authorization expires after fingerprinting", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
    ];
    const beforeExtractionLaunchAuthorization = vi.fn();
    const authorizeBeforeExtraction = vi.fn(async () => false);

    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
      {
        beforeExtractionLaunchAuthorization,
        authorizeBeforeExtraction,
      },
    );

    expect(beforeExtractionLaunchAuthorization).toHaveBeenCalledOnce();
    expect(authorizeBeforeExtraction).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      mode: "single",
      authorizationExpired: true,
      extractionFailed: [],
    });
    await expect(fs.access(renderFileFor(cwd, ORDER_TRIAGE))).rejects.toThrow();
  });

  it("renders an old-SDK (legacy-branded) workflow — the dual-brand extraction end to end", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: LEGACY_FLOW, name: "legacy-flow", definitionId: null },
    ];
    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: LEGACY_FLOW },
      workflows,
    );

    expect(outcome.extractionFailed).toEqual([]);
    const html = await readRender(cwd, LEGACY_FLOW);
    for (const step of ["receive", "confirm", "award"])
      expect(html).toContain(`>${step}<`);
  });

  it("includes detected launches as dashed launched-workflow nodes in the bound workflow's own diagram", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: HUB, name: "hub", definitionId: null },
    ];
    await renderCanvasForSession({ cwd, boundWorkflowPath: HUB }, workflows);

    const html = await readRender(cwd, HUB);
    expect(html).toContain("node--launched-workflow");
    expect(html).toContain(">spoke-workflow<");
    expect(html).toContain("launches another agent");
    expect(html).toContain("canvas-edge--launch");
    expect(html).toContain(">launch()<");
  });

  it("degrades to an honest error panel when the bound workflow fails to extract — never crashes, never falls back to an LLM prompt", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: NO_DEFINITION, name: "broken-flow", definitionId: null },
    ];
    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: NO_DEFINITION },
      workflows,
    );

    expect(outcome.mode).toBe("single");
    expect(outcome.extractionFailed).toEqual(["broken-flow"]);
    const html = await readRender(cwd, NO_DEFINITION);
    expect(html).toContain("broken-flow");
    expect(html).toContain("render failed");
    expect(html).toContain("Could not extract this agent's step graph");
    expect(html).toContain('id="sapiom-render-error"');
    // Embedded, the SPA's Render-failed card is the one message; the document's
    // prose steps aside instead of drawing through it (SAP-3199).
    expect(html).toContain('class="canvas-empty-note canvas-render-error-note"');
    expect(html).toContain(":root[data-canvas-embedded] .canvas-render-error-note { display: none; }");
    expect(html).toContain('root.setAttribute("data-canvas-embedded", "")');
    // The flag is withdrawn again if nothing takes the message over, so a
    // document that cannot post is never left blank (SAP-3199 review round 1).
    expect(html).toContain('root.removeAttribute("data-canvas-embedded")');
    expect(html).toContain('document.documentElement.setAttribute("data-canvas-error-posted", "")');
    expect(html).toContain('"title":"broken-flow"');
    expect(html).toContain("sapiom-canvas:error");
    expect(html).not.toContain('class="canvas-node '); // no diagram — just the note
  });

  it("is a cheap no-op when unbound: no extraction, no write — the server serves the empty state itself", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
    ];
    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: null },
      workflows,
    );

    expect(outcome).toEqual({ mode: "empty", extractionFailed: [] });
    await expect(fs.access(path.join(cwd, CANVAS_DIR))).rejects.toThrow(); // nothing written at all
  });

  it("treats a boundWorkflowPath that matches no known workflow as unbound", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
    ];
    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: "/no/such/workflow" },
      workflows,
    );
    expect(outcome.mode).toBe("empty");
  });

  it("never throws when the cwd is unwritable — reports writeError instead", async () => {
    // A file, not a directory, as the "cwd" — mkdir underneath it must fail.
    const parent = await tmpCwd();
    const notADir = path.join(parent, "not-a-directory");
    await fs.writeFile(notADir, "x");

    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
    ];
    const outcome = await renderCanvasForSession(
      { cwd: notADir, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );
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
      const workflows: RenderableWorkflow[] = [
        { path: NO_DEFINITION, name: "broken-flow", definitionId: null },
      ];

      const outcome = await renderCanvasForSession(
        { cwd, boundWorkflowPath: NO_DEFINITION },
        workflows,
        {
          preserveExistingOnFailure: true,
        },
      );

      expect(outcome.extractionFailed).toEqual(["broken-flow"]);
      expect(outcome.preservedExisting).toBe(true);
      expect(await readRender(cwd, NO_DEFINITION)).toBe(GOOD_RENDER);
    });

    it("still writes the honest error page when nothing exists to preserve", async () => {
      const cwd = await tmpCwd();
      const workflows: RenderableWorkflow[] = [
        { path: NO_DEFINITION, name: "broken-flow", definitionId: null },
      ];

      const outcome = await renderCanvasForSession(
        { cwd, boundWorkflowPath: NO_DEFINITION },
        workflows,
        {
          preserveExistingOnFailure: true,
        },
      );

      expect(outcome.preservedExisting).toBeUndefined();
      expect(await readRender(cwd, NO_DEFINITION)).toContain("render failed");
    });

    it("does not change explicit-render behavior: without the option, the error panel replaces the existing render", async () => {
      const cwd = await tmpCwd();
      const renderPath = renderFileFor(cwd, NO_DEFINITION);
      await fs.mkdir(path.dirname(renderPath), { recursive: true });
      await fs.writeFile(renderPath, GOOD_RENDER, "utf8");
      const workflows: RenderableWorkflow[] = [
        { path: NO_DEFINITION, name: "broken-flow", definitionId: null },
      ];

      const outcome = await renderCanvasForSession(
        { cwd, boundWorkflowPath: NO_DEFINITION },
        workflows,
      );

      expect(outcome.preservedExisting).toBeUndefined();
      expect(await readRender(cwd, NO_DEFINITION)).toContain("render failed");
    });
  });
});

describe("deriveWorkflowCanvas (the session-free entry point behind IA-01)", () => {
  const ORDER: RenderableWorkflow = {
    path: ORDER_TRIAGE,
    name: "order-triage",
    definitionId: null,
  };

  it("produces the byte-identical document the session-bound render writes to disk", async () => {
    // The proof that the workflow-keyed route (server/workflow-graph.ts) and
    // the session-keyed canvas route (server/canvas.ts) can never disagree:
    // both sides come out of this one derivation, so a board read by agent path
    // IS the board a bound session sees.
    const cwd = await tmpCwd();
    await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, [
      ORDER,
    ]);
    const written = await readRender(cwd, ORDER_TRIAGE);

    const derived = await deriveWorkflowCanvas(ORDER);

    expect(derived.status).toBe("ok");
    expect(derived.document).toBe(written);
    expect(derived.graph?.manifestName).toBeTruthy();
    expect(derived.enrichment).not.toBeNull();
  });

  it("writes nothing — no render file, no canvas dir", async () => {
    const cwd = await tmpCwd();
    await deriveWorkflowCanvas(ORDER);
    await expect(fs.stat(path.join(cwd, CANVAS_DIR))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports an extraction failure as status 'error' with the reason, never a throw", async () => {
    const derived = await deriveWorkflowCanvas({
      path: NO_DEFINITION,
      name: "broken-flow",
      definitionId: null,
    });

    expect(derived.status).toBe("error");
    expect(derived.graph).toBeNull();
    expect(derived.reason).toBeTruthy();
    expect(derived.document).toContain("render failed");
  });
});

describe("dependencies not installed yet (fresh scaffold, pre-`npm install`)", () => {
  // A temp dir under os.tmpdir() is OUTSIDE the repo, so no ancestor
  // node_modules resolves @sapiom/agent — exactly a freshly scaffolded,
  // not-yet-installed project. (The repo's own __fixtures__ resolve the SDK via
  // the monorepo's node_modules, so they are NOT deps-missing.)
  async function depsMissingProject(): Promise<string> {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "canvas-render-noinstall-"),
    );
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, "index.ts"),
      `import { defineAgent } from "@sapiom/agent";\nexport default defineAgent({ name: "x", entry: "s", steps: {} });\n`,
      "utf8",
    );
    return dir;
  }

  it("shows the calm 'preparing' placeholder — not the esbuild error — and flags depsMissing", async () => {
    const cwd = await tmpCwd();
    const project = await depsMissingProject();
    const workflows: RenderableWorkflow[] = [
      { path: project, name: "enrich-list-leads", definitionId: null },
    ];

    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: project },
      workflows,
    );

    expect(outcome.depsMissing).toBe(true);
    expect(outcome.extractionFailed).toEqual([]);
    const html = await readRender(cwd, project);
    expect(html).toContain("Preparing your agent");
    // Crucially NOT the honest-error panel: no "render failed" badge, and no
    // #sapiom-render-error script (which the SPA turns into the Retry card).
    expect(html).not.toContain("render failed");
    expect(html).not.toContain("Could not resolve");
    expect(html).not.toContain('id="sapiom-render-error"');
  });

  it("preserves an existing good render on an unprompted deps-missing pass", async () => {
    const cwd = await tmpCwd();
    const project = await depsMissingProject();
    const renderPath = renderFileFor(cwd, project);
    await fs.mkdir(path.dirname(renderPath), { recursive: true });
    await fs.writeFile(renderPath, "<!doctype html><!-- good -->", "utf8");
    const workflows: RenderableWorkflow[] = [
      { path: project, name: "enrich-list-leads", definitionId: null },
    ];

    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: project },
      workflows,
      {
        preserveExistingOnFailure: true,
      },
    );

    expect(outcome.depsMissing).toBe(true);
    expect(outcome.preservedExisting).toBe(true);
    expect(await readRender(cwd, project)).toBe("<!doctype html><!-- good -->");
  });

  it("surfaceErrorOnMissingDeps forces the honest error (the install-timeout safety valve)", async () => {
    const cwd = await tmpCwd();
    const project = await depsMissingProject();
    const workflows: RenderableWorkflow[] = [
      { path: project, name: "enrich-list-leads", definitionId: null },
    ];

    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: project },
      workflows,
      {
        surfaceErrorOnMissingDeps: true,
      },
    );

    // Extraction runs and genuinely fails to resolve the SDK — the error panel
    // (and its Retry/Ask actions) is restored, and depsMissing is NOT set.
    expect(outcome.depsMissing).toBeUndefined();
    expect(outcome.extractionFailed).toEqual(["enrich-list-leads"]);
    expect(await readRender(cwd, project)).toContain("render failed");
  });
});

describe("deterministic enrichment merged into renders", () => {
  const workflows: RenderableWorkflow[] = [
    { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
  ];

  it("always annotates a successful render with a derived summary — no cache, no AI, no stale chip", async () => {
    const cwd = await tmpCwd();
    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );
    expect(outcome.enrichmentApplied).toBe(true);

    const html = await readRender(cwd, ORDER_TRIAGE);
    // order-triage: 3 pipeline steps, one branch point, two success terminals.
    expect(html).toContain("3 steps · 1 branch point · 2 success outcomes");
    expect(html).not.toContain("stale — Refresh");
    // Never writes an enrichment cache dir — the annotation is recomputed each render.
    await expect(
      fs.access(path.join(cwd, CANVAS_DIR, "cache")),
    ).rejects.toThrow();
  });

  it("is byte-stable across re-renders — same graph in, identical annotated HTML out", async () => {
    const cwd = await tmpCwd();
    await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );
    const first = await readRender(cwd, ORDER_TRIAGE);
    clearExtractionCache();
    await renderCanvasForSession(
      { cwd, boundWorkflowPath: ORDER_TRIAGE },
      workflows,
    );
    expect(await readRender(cwd, ORDER_TRIAGE)).toBe(first);
  });

  it("carries no annotations on an extraction-failure panel", async () => {
    const cwd = await tmpCwd();
    const broken: RenderableWorkflow[] = [
      { path: NO_DEFINITION, name: "broken-flow", definitionId: null },
    ];

    const outcome = await renderCanvasForSession(
      { cwd, boundWorkflowPath: NO_DEFINITION },
      broken,
    );
    expect(outcome.enrichmentApplied).toBeUndefined();
    const html = await readRender(cwd, NO_DEFINITION);
    expect(html).toContain("render failed");
    // No rendered summary element (the `.canvas-subtitle` CSS rule always
    // lives in the <style> block; the <p> only appears when there's a summary).
    expect(html).not.toContain('<p class="canvas-subtitle">');
  });
});
