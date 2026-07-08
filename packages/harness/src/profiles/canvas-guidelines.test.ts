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
});

describe("CANVAS_STYLE_GUIDELINES injection sites", () => {
  it("is embedded verbatim in the default system prompt's canvas paragraph", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(CANVAS_STYLE_GUIDELINES);
  });

  it("is embedded verbatim in the visualize macro's inject text", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "visualize")!;
    expect(macro.action.kind).toBe("inject");
    if (macro.action.kind === "inject") {
      expect(macro.action.text).toContain(CANVAS_STYLE_GUIDELINES);
      // Still templates {{subject}} correctly alongside the appended contract.
      expect(macro.action.text).toContain("{{subject}}");
    }
  });
});
