import { describe, expect, it } from "vitest";

import { renderCanvasDocument } from "./canvas-template.js";

describe("renderCanvasDocument", () => {
  it("produces a single self-contained document: no external stylesheets, scripts, or fetches", () => {
    const html = renderCanvasDocument("<p>hi</p>");
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i);
    // The inline scripts (theme switch + run-state listener) must never issue
    // a network fetch — the iframe is sandboxed (allow-scripts only).
    expect(html).not.toMatch(/\bfetch\s*\(/);
  });

  it("injects the run-state postMessage listener so nodes light up during a live run", () => {
    const html = renderCanvasDocument("<p>x</p>");
    // The message type guard — proves the listener is wired.
    expect(html).toContain("sapiom:run-state");
    // The boot call — proves the listener is activated, not just defined.
    expect(html).toContain("bootCanvasRunState()");
    // The three function bodies should all be present.
    expect(html).toContain("runStateNodeClass");
    expect(html).toContain("applyRunStateToCanvas");
    expect(html).toContain("bootCanvasRunState");
  });

  it("injects the node-click reverse channel so clicking a canvas node notifies the parent", () => {
    const html = renderCanvasDocument("<p>x</p>");
    // The reverse message type — proves the click channel is wired.
    expect(html).toContain("sapiom:node-click");
    // The boot call — proves the listener is activated, not just defined.
    expect(html).toContain("bootCanvasNodeClicks()");
    // The function body itself must be present.
    expect(html).toContain("bootCanvasNodeClicks");
  });

  it("bridges the harness gesture layer: the board hit-tests sapiom-canvas:pick / :hover", () => {
    const html = renderCanvasDocument("<p>x</p>");
    // The gesture layer overlays the iframe and swallows raw clicks, so the
    // board must answer the forwarded pick/hover points, not just DOM clicks.
    expect(html).toContain("sapiom-canvas:pick");
    expect(html).toContain("sapiom-canvas:hover");
    // Hit-testing the forwarded point is what makes a node still select.
    expect(html).toContain("elementFromPoint");
    // Hover answers the hit channel so the gesture layer shows a pointer cursor.
    expect(html).toContain("sapiom-canvas:hit");
  });

  it("injects the pan/zoom view channel so the canvas can zoom and move", () => {
    const html = renderCanvasDocument("<p>x</p>");
    // The parent posts the view; without this receiver zoom/pan are dropped.
    expect(html).toContain("sapiom-canvas:view");
    expect(html).toContain("bootCanvasView()");
    // The iframe element never transforms — the view rides #canvas-root.
    expect(html).toContain('getElementById("canvas-root")');
    expect(html).toContain("transform");
    // The doc reports its natural size so the parent can fit-to-view.
    expect(html).toContain("sapiom-canvas:size");
  });

  it("prepends a __name shim so esbuild/tsx keepNames output doesn't throw in the iframe", () => {
    // Under tsx/esbuild the stringified boot functions contain `__name(fn,"fn")`
    // calls whose helper lives at module scope (not captured by toString()).
    // The shim must be defined in the injected script or the whole <script>
    // throws ReferenceError and node-click + pan/zoom silently die.
    const html = renderCanvasDocument("<p>x</p>");
    expect(html).toContain("function __name");
    // If any __name(...) call is present, the shim definition must precede it.
    const firstCall = html.indexOf("__name(");
    if (firstCall !== -1) {
      expect(html.indexOf("function __name")).toBeGreaterThanOrEqual(0);
      expect(html.indexOf("function __name")).toBeLessThan(firstCall);
    }
  });

  it("makes canvas nodes read as clickable via cursor: pointer CSS", () => {
    const html = renderCanvasDocument("<p>x</p>");
    expect(html).toContain("cursor: pointer");
  });

  it("includes is-running / is-passed / is-failed CSS rules for node live-state lighting", () => {
    const html = renderCanvasDocument("");
    expect(html).toContain("is-running");
    expect(html).toContain("is-passed");
    expect(html).toContain("is-failed");
    // The pulse animation for running nodes.
    expect(html).toContain("canvas-node-pulse");
    // The active badge class for the header badge during a run.
    expect(html).toContain("canvas-badge--active");
  });

  it("embeds the given body content verbatim inside #canvas-root", () => {
    const html = renderCanvasDocument("<p>marker-content-xyz</p>");
    expect(html).toContain('<div id="canvas-root">');
    expect(html).toContain("marker-content-xyz");
  });

  it("bakes in both palettes and defaults to light without consulting the OS", () => {
    const html = renderCanvasDocument("");
    expect(html).toContain('[data-canvas-theme="dark"]');
    expect(html).toMatch(/theme === "light" \|\| theme === "dark" \? theme : "light"/);
    expect(html).not.toContain("prefers-color-scheme");
    // Exact dark-theme accent hex from web/src/styles.css — same palette the
    // rest of the app renders in dark mode.
    expect(html).toContain("#6be195");
    // Exact light-theme accent hex — the Studio light --brand green (aligned
    // with the dark theme's green; it was an off-brand cyan before).
    expect(html).toContain("#167e3a");
  });

  it("reads the theme from a ?theme= query param client-side, with no server-side dependency", () => {
    const html = renderCanvasDocument("");
    expect(html).toMatch(/URLSearchParams\(location\.search\)/);
    expect(html).toMatch(/params\.get\("theme"\)/);
  });

  it("ships the SVG defs (glow filter, arrow markers) every node/edge pattern references", () => {
    const html = renderCanvasDocument("");
    expect(html).toContain('id="canvas-glow"');
    expect(html).toContain('id="canvas-arrow"');
    expect(html).toContain('id="canvas-arrow-success"');
    expect(html).toContain('id="canvas-arrow-warn"');
  });

  it("bakes the diagram as markup — no legacy client-side SVG builder", () => {
    const html = renderCanvasDocument("");
    // The old AI path shipped a `canvas-data` JSON block that a runtime script
    // turned INTO the SVG. The deterministic render never does: the diagram is
    // server-rendered markup.
    expect(html).not.toMatch(/canvas-data/);
  });

  it("posts the embedded step graph to the parent (Steps tab source of truth)", () => {
    const html = renderCanvasDocument("");
    // The one JSON the doc parses is the embedded `#sapiom-graph` payload it
    // POSTS to the parent — never to draw the board. Without this the Steps
    // tab reads "No steps yet" even when the diagram is visible.
    expect(html).toContain("sapiom-canvas:graph");
    expect(html).toContain('getElementById("sapiom-graph")');
  });

  it("bridges a deterministic render failure to the workbench error overlay", () => {
    const html = renderCanvasDocument("");
    expect(html).toContain("sapiom-canvas:error");
    expect(html).toContain('getElementById("sapiom-render-error")');
    expect(html).toContain("bootCanvasError()");
  });
});
