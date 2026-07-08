import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CANVAS_INDEX } from "../shared/types.js";
import { renderCanvasForSession, type RenderableWorkflow } from "./canvas-render.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ORDER_TRIAGE = path.join(FIXTURES_DIR, "order-triage");
const NO_DEFINITION = path.join(FIXTURES_DIR, "no-definition");
const HUB = path.join(FIXTURES_DIR, "hub");
const SPOKE = path.join(FIXTURES_DIR, "spoke");

const tmpDirs: string[] = [];
async function tmpCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-render-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function readIndex(cwd: string): Promise<string> {
  return fs.readFile(path.join(cwd, CANVAS_INDEX), "utf8");
}

describe("renderCanvasForSession", () => {
  it("renders the bound workflow's real step names into a single panel", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: ORDER_TRIAGE }, workflows);

    expect(outcome).toEqual({ mode: "single", workflowPath: ORDER_TRIAGE, extractionFailed: [] });
    const html = await readIndex(cwd);
    for (const step of ["intake", "classify", "route", "auto_resolve", "escalate"]) {
      expect(html).toContain(`>${step}<`);
    }
    expect(html).toContain("canvas-legend");
    expect(html).not.toContain('class="canvas-panel canvas-interconnections"');
  });

  it("degrades to an honest error panel when the bound workflow fails to extract — never crashes, never falls back to an LLM prompt", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: NO_DEFINITION }, workflows);

    expect(outcome.mode).toBe("single");
    expect(outcome.extractionFailed).toEqual(["broken-flow"]);
    const html = await readIndex(cwd);
    expect(html).toContain("broken-flow");
    expect(html).toContain("render failed");
    expect(html).toContain("Could not extract this workflow's step graph");
    expect(html).not.toContain('class="canvas-node '); // no diagram — just the note
  });

  it("renders the whole-workspace overview (one panel per workflow) when unbound", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: 42 },
      { path: HUB, name: "hub", definitionId: null },
    ];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows);

    expect(outcome.mode).toBe("overview");
    expect(outcome.workflowCount).toBe(2);
    expect(outcome.extractionFailed).toEqual([]);
    const html = await readIndex(cwd);
    expect(html).toContain(">order-triage<");
    expect(html).toContain(">hub<");
    expect(html).toContain("deployed");
    expect(html).toContain("local only");
  });

  it("includes an Interconnections panel when a workspace overview's workflows reference each other", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: HUB, name: "hub", definitionId: null },
      { path: SPOKE, name: "spoke", definitionId: null },
    ];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows);

    expect(outcome.mode).toBe("overview");
    const html = await readIndex(cwd);
    expect(html).toContain('class="canvas-panel canvas-interconnections"');
    expect(html).toContain("hub &rarr; spoke");
    expect(html).toContain('class="canvas-interconnection-tag">launch<');
  });

  it("degrades one panel at a time in an overview — one broken workflow doesn't take down the others", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [
      { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
      { path: NO_DEFINITION, name: "broken-flow", definitionId: null },
    ];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows);

    expect(outcome.mode).toBe("overview");
    expect(outcome.extractionFailed).toEqual(["broken-flow"]);
    const html = await readIndex(cwd);
    expect(html).toContain(">intake<"); // order-triage still rendered in full
    expect(html).toContain("render failed"); // broken-flow degraded, not dropped
  });

  it("renders a friendly empty-workspace note (not an error) when unbound with zero known workflows", async () => {
    const cwd = await tmpCwd();
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, []);

    expect(outcome).toEqual({ mode: "empty", extractionFailed: [] });
    const html = await readIndex(cwd);
    expect(html).toContain("No workflows found");
    expect(html).not.toContain("render failed");
  });

  it("falls back to the workspace overview when boundWorkflowPath doesn't match any known workflow", async () => {
    const cwd = await tmpCwd();
    const workflows: RenderableWorkflow[] = [{ path: ORDER_TRIAGE, name: "order-triage", definitionId: null }];
    const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: "/no/such/workflow" }, workflows);
    expect(outcome.mode).toBe("overview");
  });

  it("never throws when the cwd is unwritable — reports writeError instead", async () => {
    // A file, not a directory, as the "cwd" — mkdir underneath it must fail.
    const parent = await tmpCwd();
    const notADir = path.join(parent, "not-a-directory");
    await fs.writeFile(notADir, "x");

    const outcome = await renderCanvasForSession({ cwd: notADir, boundWorkflowPath: null }, []);
    expect(outcome.mode).toBe("empty");
    expect(outcome.writeError).toBeTruthy();
  });

  describe("preserveExistingOnFailure (unprompted auto-renders)", () => {
    const SEEDED_CANVAS = "<!doctype html><!-- seeded opening shot -->";

    async function seedCanvas(cwd: string): Promise<void> {
      const indexPath = path.join(cwd, CANVAS_INDEX);
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.writeFile(indexPath, SEEDED_CANVAS, "utf8");
    }

    it("keeps an existing canvas when every extraction failed, instead of replacing it with error panels", async () => {
      const cwd = await tmpCwd();
      await seedCanvas(cwd);
      const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];

      const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows, {
        preserveExistingOnFailure: true,
      });

      expect(outcome.extractionFailed).toEqual(["broken-flow"]);
      expect(outcome.preservedExisting).toBe(true);
      expect(await readIndex(cwd)).toBe(SEEDED_CANVAS);
    });

    it("still writes the honest error page when nothing exists to preserve", async () => {
      const cwd = await tmpCwd();
      const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];

      const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows, {
        preserveExistingOnFailure: true,
      });

      expect(outcome.preservedExisting).toBeUndefined();
      expect(await readIndex(cwd)).toContain("render failed");
    });

    it("overwrites the existing canvas when at least one workflow rendered — a partial overview beats a stale shot", async () => {
      const cwd = await tmpCwd();
      await seedCanvas(cwd);
      const workflows: RenderableWorkflow[] = [
        { path: ORDER_TRIAGE, name: "order-triage", definitionId: null },
        { path: NO_DEFINITION, name: "broken-flow", definitionId: null },
      ];

      const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows, {
        preserveExistingOnFailure: true,
      });

      expect(outcome.preservedExisting).toBeUndefined();
      const html = await readIndex(cwd);
      expect(html).toContain(">intake<");
      expect(html).not.toBe(SEEDED_CANVAS);
    });

    it("does not change explicit-render behavior: without the option, error panels replace the existing canvas", async () => {
      const cwd = await tmpCwd();
      await seedCanvas(cwd);
      const workflows: RenderableWorkflow[] = [{ path: NO_DEFINITION, name: "broken-flow", definitionId: null }];

      const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: null }, workflows);

      expect(outcome.preservedExisting).toBeUndefined();
      expect(await readIndex(cwd)).toContain("render failed");
    });
  });
});
