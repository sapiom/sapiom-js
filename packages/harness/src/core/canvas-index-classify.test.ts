import { describe, it, expect } from "vitest";

import {
  isLegacyDeterministicCanvas,
  isMachineGeneratedCanvas,
  isSeededCanvasTemplate,
} from "./canvas-index-classify.js";
import { assembleCanvasBody, buildErrorPanelHtml } from "./canvas-body.js";
import { renderCanvasDocument, TEMPLATE_HTML } from "./canvas-template.js";

/** A realistic reproduction of the stale legacy overview a pre-split server
 *  wrote to index.html: the shared shell wrapping stacked "render failed"
 *  panels and the deterministic "Static preview —" footer note. */
const LEGACY_OVERVIEW_HTML = renderCanvasDocument(
  assembleCanvasBody({
    panels: [
      buildErrorPanelHtml("text-to-image", "No agent was exported"),
      buildErrorPanelHtml("logo-flow", "No agent was exported"),
    ],
    legend: "",
    note: "Static preview — regenerate after a workflow changes (2 workflows failed to build).",
  }),
);

/** What an agent authors after cloning the template and filling it in — the
 *  patterns block and empty-state note are gone, and there is no deterministic
 *  footer note. */
const AGENT_CUSTOM_HTML = renderCanvasDocument(
  `<section class="canvas-panel"><h1 class="canvas-title">My hand-built canvas</h1><p>bespoke content</p></section>`,
);

describe("isLegacyDeterministicCanvas", () => {
  it("matches a legacy deterministic overview written to index.html", () => {
    expect(isLegacyDeterministicCanvas(LEGACY_OVERVIEW_HTML)).toBe(true);
  });

  it("does not match the seeded template", () => {
    expect(isLegacyDeterministicCanvas(TEMPLATE_HTML)).toBe(false);
  });

  it("does not match an agent-authored custom canvas", () => {
    expect(isLegacyDeterministicCanvas(AGENT_CUSTOM_HTML)).toBe(false);
  });
});

describe("isSeededCanvasTemplate", () => {
  it("matches the pristine seeded template", () => {
    expect(isSeededCanvasTemplate(TEMPLATE_HTML)).toBe(true);
  });

  it("does not match a legacy overview", () => {
    expect(isSeededCanvasTemplate(LEGACY_OVERVIEW_HTML)).toBe(false);
  });

  it("does not match an agent canvas that deleted the patterns block and empty note", () => {
    expect(isSeededCanvasTemplate(AGENT_CUSTOM_HTML)).toBe(false);
  });
});

describe("isMachineGeneratedCanvas", () => {
  it("is true for both the seeded template and a legacy overview", () => {
    expect(isMachineGeneratedCanvas(TEMPLATE_HTML)).toBe(true);
    expect(isMachineGeneratedCanvas(LEGACY_OVERVIEW_HTML)).toBe(true);
  });

  it("is false for a genuine agent-authored custom canvas", () => {
    expect(isMachineGeneratedCanvas(AGENT_CUSTOM_HTML)).toBe(false);
  });

  it("is false for arbitrary hand-written HTML", () => {
    expect(isMachineGeneratedCanvas("<html><body>custom</body></html>")).toBe(false);
  });
});
