import { describe, it, expect } from "vitest";
import { CANVAS_STYLE_GUIDELINES } from "./canvas-guidelines.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default.js";
import { DEFAULT_MACROS } from "../core/macros.js";

describe("CANVAS_STYLE_GUIDELINES", () => {
  it("is non-empty and prompt-sized (not a docs-length dump)", () => {
    expect(CANVAS_STYLE_GUIDELINES.length).toBeGreaterThan(0);
    // ~30 lines max, by design — this rides in prompts, not docs.
    expect(CANVAS_STYLE_GUIDELINES.split("\n").length).toBeLessThanOrEqual(30);
  });

  it("covers the self-contained / no-external-requests rule", () => {
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/self-contained/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/external/i);
  });

  it("carries the exact dark-theme palette hexes from web/src/styles.css", () => {
    // [data-theme="dark"] tokens: --bg-0, --border, --text, --accent/--green,
    // --amber, --red. Kept in sync by eye — see the file's own doc comment.
    for (const hex of ["#0f0f0f", "#1a1a1a", "#2e2e2e", "#fafafa", "#6be195", "#f59e0b", "#f87171"]) {
      expect(CANVAS_STYLE_GUIDELINES).toContain(hex);
    }
  });

  it("documents node/edge conventions and terminal-outcome color coding", () => {
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/rounded/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/arrow/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/success/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/escalation/i);
  });

  it("documents the stats header and legend footer patterns", () => {
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/stats/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/legend/i);
  });

  it("carries a 'prefer clarity over decoration' note", () => {
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/clarity over decoration/i);
  });

  // Regression coverage for three ambiguities a live Visualize proof
  // surfaced: two different runs resolved each one inconsistently because
  // the wording left room to. See canvas-guidelines.ts's doc comment.
  it("requires every node to get the glow, not just entry/terminal ones", () => {
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/every node/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/never reserve the glow/i);
  });

  it("specifies straight edges for sequential steps and curved only for branches", () => {
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/straight lines/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/branches into\s+multiple successors/i);
  });

  it("requires visually distinct legend markers per node kind, not just per color", () => {
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/visually distinct marker/i);
    expect(CANVAS_STYLE_GUIDELINES).toMatch(/never reuse the identical marker/i);
  });
});

describe("CANVAS_STYLE_GUIDELINES injection sites", () => {
  it("is embedded verbatim in the default system prompt's canvas paragraph — the freeform path", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(CANVAS_STYLE_GUIDELINES);
  });

  it("is NOT embedded in the ai-visualize macro's inject text — the canvas kit's prebuilt template already carries the style, so the macro path only ever asks for a data edit", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "ai-visualize")!;
    expect(macro.action.kind).toBe("inject");
    if (macro.action.kind === "inject") {
      expect(macro.action.text).not.toContain(CANVAS_STYLE_GUIDELINES);
    }
  });

  it("the default visualize macro doesn't touch a prompt at all — it's a server-side deterministic render", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "visualize")!;
    expect(macro.action).toEqual({ kind: "render-canvas" });
  });
});
