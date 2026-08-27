import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkflowGraphRouter,
  type WorkflowGraphResponse,
  type WorkflowGraphRouterDeps,
} from "./workflow-graph.js";
import type { WorkflowCanvasDerivation } from "../core/canvas-render.js";
import type { CanvasGraph } from "../core/canvas-graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GRAPH: CanvasGraph = {
  manifestName: "order-triage",
  entry: "intake",
  nodes: [
    { id: "intake", kind: "entry", label: "Intake" },
    { id: "done", kind: "terminal-success", label: "Done" },
  ],
  edges: [{ from: "intake", to: "done", kind: "sequential" }],
  warnings: [],
};

/** A successful derivation, as `deriveWorkflowCanvas` would return it. */
function okDerivation(overrides: Partial<WorkflowCanvasDerivation> = {}): WorkflowCanvasDerivation {
  return {
    status: "ok",
    graph: GRAPH,
    enrichment: { summary: "1 step · 1 success outcome" },
    reason: null,
    cached: false,
    document: "<!doctype html><title>board</title>",
    ...overrides,
  };
}

describe("GET /api/workflows/:path/graph", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  const tmpDirs: string[] = [];

  function start(deps: WorkflowGraphRouterDeps): void {
    const app = express();
    app.use(createWorkflowGraphRouter(deps));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** GET the route for `agentPath`, encoded the way the SPA encodes it. */
  async function get(agentPath: string): Promise<Response> {
    return fetch(`${baseUrl}/api/workflows/${encodeURIComponent(agentPath)}/graph`);
  }

  async function makeTmpDir(): Promise<string> {
    // realpath: macOS hands back /var, which is a symlink to /private/var —
    // the route realpaths too, so the fixture must compare like with like.
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wf-graph-")));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns a graph derived from disk for a registered agent, with no session involved", async () => {
    const deriveCanvas = vi.fn().mockResolvedValue(okDerivation({ cached: true }));
    start({
      resolveWorkflow: () => ({ path: "/registered/agent", name: "order-triage", definitionId: 7 }),
      inspectMarker: () => Promise.resolve({ status: "valid", marker: { definitionId: 7 } }),
      realpath: (p) => Promise.resolve(p),
      deriveCanvas,
    });

    const res = await get("/registered/agent");
    const body = (await res.json()) as WorkflowGraphResponse;

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.path).toBe("/registered/agent");
    expect(body.name).toBe("order-triage");
    expect(body.graph).toEqual(GRAPH);
    expect(body.cached).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.document).toContain("<!doctype html>");
    // The registry's identity is what gets rendered — badges and the panel
    // title come from it, exactly as the session-bound render builds them.
    expect(deriveCanvas).toHaveBeenCalledWith({
      path: "/registered/agent",
      name: "order-triage",
      definitionId: 7,
      activeBuildRunStatus: null,
    });
  });

  it("serves an agent that has never had a session — nothing in the request names one", async () => {
    start({
      resolveWorkflow: () => ({ path: "/never/sessioned", name: "fresh", definitionId: null }),
      inspectMarker: () => Promise.resolve({ status: "valid", marker: { definitionId: null } }),
      realpath: (p) => Promise.resolve(p),
      deriveCanvas: () => Promise.resolve(okDerivation()),
    });

    const res = await get("/never/sessioned");

    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkflowGraphResponse).graph).toEqual(GRAPH);
  });

  it("reads sapiom.json off real disk through the default marker inspection", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "sapiom.json"), JSON.stringify({ definitionId: 42 }), "utf8");
    start({
      resolveWorkflow: () => ({ path: dir, name: "on-disk", definitionId: 42 }),
      deriveCanvas: () => Promise.resolve(okDerivation()),
    });

    const body = (await (await get(dir)).json()) as WorkflowGraphResponse;

    expect(body.status).toBe("ok");
    expect(body.path).toBe(dir);
  });

  it("derives a REAL graph end-to-end for an agent no session has ever touched", async () => {
    // No stubs below resolveWorkflow: the real sapiom.json inspection, the real
    // extraction (esbuild, in a child process) and the real document build all
    // run. This is the criterion "an agent that has never had a session returns
    // a real graph" — nothing in the request, the router, or the derivation
    // names a session or a session cwd.
    //
    // The project lives INSIDE this package so its `@sapiom/agent` import
    // resolves through an ancestor node_modules, exactly as a real installed
    // agent project does; a bare os.tmpdir() copy would read as deps-missing
    // and render the "preparing" placeholder instead.
    const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const agent = await fs.realpath(await fs.mkdtemp(path.join(packageDir, ".tmp-wf-graph-")));
    tmpDirs.push(agent);
    await fs.copyFile(
      path.join(packageDir, "src", "core", "__fixtures__", "order-triage", "index.ts"),
      path.join(agent, "index.ts"),
    );
    await fs.writeFile(path.join(agent, "sapiom.json"), JSON.stringify({ definitionId: null }), "utf8");

    start({ resolveWorkflow: () => ({ path: agent, name: "order-triage", definitionId: null }) });

    const res = await get(agent);
    const body = (await res.json()) as WorkflowGraphResponse;

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.graph?.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(["intake", "classify", "route", "auto_resolve", "escalate"]),
    );
    expect(body.graph?.edges.length).toBeGreaterThan(0);
    expect(body.enrichment?.summary).toBeTruthy();
    // The document is the board itself, not a placeholder or an error panel.
    expect(body.document).toContain("intake");
    expect(body.document).not.toContain("render failed");
    expect(body.document).not.toContain("Preparing your agent");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Failure modes — each distinct from the others AND from "no route"
  // -------------------------------------------------------------------------

  it("404s an unregistered path, before touching disk", async () => {
    const inspectMarker = vi.fn();
    const deriveCanvas = vi.fn();
    start({ resolveWorkflow: () => null, inspectMarker, deriveCanvas });

    const res = await get("/outside/agent");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "agent not found" });
    expect(inspectMarker).not.toHaveBeenCalled();
    expect(deriveCanvas).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a `..` climb", input: "/registered/agent/../../etc", error: "agent path must not contain a '..' segment" },
    { label: "a bare `..` segment", input: "/../etc/passwd", error: "agent path must not contain a '..' segment" },
    { label: "a relative path", input: "registered/agent", error: "agent path must be absolute" },
    { label: "an empty path", input: "   ", error: "agent path is required" },
  ])("400s $label without consulting the registry", async ({ input, error }) => {
    const resolveWorkflow = vi.fn().mockReturnValue({ path: "/x", name: "x", definitionId: null });
    const deriveCanvas = vi.fn();
    start({ resolveWorkflow, inspectMarker: () => Promise.resolve({ status: "valid", marker: {} }), deriveCanvas });

    const res = await get(input);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(resolveWorkflow).not.toHaveBeenCalled();
    expect(deriveCanvas).not.toHaveBeenCalled();
  });

  it("rejects traversal even when normalization would land on a registered path", async () => {
    // `/registered/agent/../agent` normalizes to `/registered/agent`, which IS
    // registered. Resolving first and asking questions later would have served
    // it; the raw-value guard refuses the shape outright.
    const resolveWorkflow = vi.fn().mockReturnValue({ path: "/registered/agent", name: "a", definitionId: null });
    start({ resolveWorkflow, deriveCanvas: () => Promise.resolve(okDerivation()) });

    const res = await get("/registered/agent/../agent");

    expect(res.status).toBe(400);
    expect(resolveWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a sapiom.json symlinked out of the agent directory", async () => {
    const dir = await makeTmpDir();
    const agent = path.join(dir, "agent");
    const outside = path.join(dir, "outside");
    await fs.mkdir(agent);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secrets.json"), "{}", "utf8");
    await fs.symlink(path.join(outside, "secrets.json"), path.join(agent, "sapiom.json"));

    const inspectMarker = vi.fn();
    start({
      resolveWorkflow: () => ({ path: agent, name: "agent", definitionId: null }),
      inspectMarker,
      deriveCanvas: () => Promise.resolve(okDerivation()),
    });

    const res = await get(agent);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sapiom.json resolves outside the agent directory" });
    expect(inspectMarker).not.toHaveBeenCalled();
  });

  it("accepts a symlinked agent DIRECTORY — the marker still resolves inside it", async () => {
    const dir = await makeTmpDir();
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, "sapiom.json"), JSON.stringify({ definitionId: null }), "utf8");
    await fs.symlink(real, link);

    start({
      resolveWorkflow: () => ({ path: link, name: "linked", definitionId: null }),
      deriveCanvas: () => Promise.resolve(okDerivation()),
    });

    const res = await get(link);

    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkflowGraphResponse).status).toBe("ok");
  });

  it.each([
    { status: "absent" as const, reason: "This agent has no sapiom.json, so there is no graph to render yet." },
    { status: "invalid" as const, reason: "This agent's sapiom.json is not valid JSON, so its graph can't be read." },
    { status: "unreadable" as const, reason: "This agent's sapiom.json could not be read." },
  ])("returns 200 + an explicit empty graph when the marker is $status", async ({ status, reason }) => {
    const deriveCanvas = vi.fn();
    start({
      resolveWorkflow: () => ({ path: "/registered/agent", name: "order-triage", definitionId: null }),
      inspectMarker: () => Promise.resolve({ status }),
      realpath: (p) => Promise.resolve(p),
      deriveCanvas,
    });

    const res = await get("/registered/agent");
    const body = (await res.json()) as WorkflowGraphResponse;

    // 200, not 404 and not 422: absent ⇒ empty, not an error. A consumer tells
    // this apart from "no route" by the status code alone, and apart from a
    // real board by `status`.
    expect(res.status).toBe(200);
    expect(body.status).toBe("empty");
    expect(body.graph).toBeNull();
    expect(body.reason).toBe(reason);
    // Still a renderable page, so the pane is never mutely blank.
    expect(body.document).toContain("Nothing rendered yet");
    expect(deriveCanvas).not.toHaveBeenCalled();
  });

  it("returns 200 empty (not 404) for a registered agent whose directory is gone", async () => {
    start({
      resolveWorkflow: () => ({ path: "/registered/vanished", name: "vanished", definitionId: null }),
      deriveCanvas: () => Promise.resolve(okDerivation()),
    });

    const res = await get("/registered/vanished");
    const body = (await res.json()) as WorkflowGraphResponse;

    expect(res.status).toBe(200);
    expect(body.status).toBe("empty");
    expect(body.reason).toBe("This agent's directory is no longer on disk.");
  });

  // -------------------------------------------------------------------------
  // A THROWN derivation must not take the process with it
  // -------------------------------------------------------------------------

  it("answers a THROWING derivation with a JSON error board, not an unhandled rejection", async () => {
    // `deriveWorkflowCanvas` spawns a child, parses a manifest this process did
    // not write, and walks user directories that can EACCES. Express 4 does not
    // catch a rejected async handler, and there is no `unhandledRejection`
    // handler in this package — so before the try/catch this request was never
    // answered and the harness died under Node's default throw behaviour.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    start({
      resolveWorkflow: () => ({ path: "/registered/agent", name: "order-triage", definitionId: null }),
      inspectMarker: () => Promise.resolve({ status: "valid", marker: {} }),
      realpath: (p) => Promise.resolve(p),
      deriveCanvas: () => Promise.reject(new Error("esbuild exited with code 1")),
    });

    try {
      const res = await get("/registered/agent");
      const body = (await res.json()) as WorkflowGraphResponse;

      expect(res.status).toBe(200);
      expect(body.status).toBe("error");
      expect(body.graph).toBeNull();
      expect(body.enrichment).toBeNull();
      expect(body.reason).toContain("esbuild exited with code 1");
      // Still a renderable page: the pane shows the reason, it does not spin.
      expect(body.document).toContain("Couldn't render this board");
      // The request was answered, so nothing was left to reject.
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("answers a throwing MARKER INSPECTION the same way", async () => {
    // The other unguarded await: reading `sapiom.json` off a directory that
    // EACCESes mid-read throws just as readily as the extraction does.
    start({
      resolveWorkflow: () => ({ path: "/registered/agent", name: "order-triage", definitionId: null }),
      inspectMarker: () => Promise.reject(new Error("EACCES: permission denied")),
      realpath: (p) => Promise.resolve(p),
      deriveCanvas: () => Promise.resolve(okDerivation()),
    });

    const body = (await (await get("/registered/agent")).json()) as WorkflowGraphResponse;

    expect(body.status).toBe("error");
    expect(body.reason).toContain("EACCES");
  });

  // -------------------------------------------------------------------------
  // The registry's path, not the request's, is what reaches the disk
  // -------------------------------------------------------------------------

  it("reads the REGISTRY's path, not the string the request spelled", async () => {
    // The request is a lookup key and nothing else. A registry that answers
    // with a different directory than the one asked for is what proves it:
    // every disk call, and the reported path, follow the registry.
    const realpath = vi.fn((p: string) => Promise.resolve(p));
    const inspectMarker = vi.fn(() => Promise.resolve({ status: "valid" as const, marker: {} }));
    start({
      resolveWorkflow: () => ({ path: "/registry/says/here", name: "order-triage", definitionId: null }),
      inspectMarker,
      realpath,
      deriveCanvas: () => Promise.resolve(okDerivation()),
    });

    const body = (await (await get("/request/says/there")).json()) as WorkflowGraphResponse;

    expect(realpath).toHaveBeenCalledWith("/registry/says/here");
    expect(realpath).not.toHaveBeenCalledWith("/request/says/there");
    expect(inspectMarker).toHaveBeenCalledWith("/registry/says/here");
    expect(body.path).toBe("/registry/says/here");
  });

  it.each([
    { derived: { status: "error" as const, reason: "Could not resolve @sapiom/agent" }, expectReason: "Could not resolve @sapiom/agent" },
    { derived: { status: "preparing" as const, reason: null }, expectReason: null },
  ])("passes through a $derived.status derivation as a 200", async ({ derived, expectReason }) => {
    start({
      resolveWorkflow: () => ({ path: "/registered/agent", name: "order-triage", definitionId: null }),
      inspectMarker: () => Promise.resolve({ status: "valid", marker: {} }),
      realpath: (p) => Promise.resolve(p),
      deriveCanvas: () =>
        Promise.resolve(
          okDerivation({ ...derived, graph: null, enrichment: null, document: "<!doctype html><title>panel</title>" }),
        ),
    });

    const res = await get("/registered/agent");
    const body = (await res.json()) as WorkflowGraphResponse;

    expect(res.status).toBe(200);
    expect(body.status).toBe(derived.status);
    expect(body.graph).toBeNull();
    expect(body.reason).toBe(expectReason);
    expect(body.document).toContain("<!doctype html>");
  });
});
