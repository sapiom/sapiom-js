import { describe, expect, it } from "vitest";

import { CANVAS_STYLE_GUIDELINES } from "./canvas-guidelines.js";
import { CLI_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT } from "./default.js";

describe("system prompt split (core vs canvas)", () => {
  it("DEFAULT_SYSTEM_PROMPT is the core followed by the canvas/app sections", () => {
    // The split refactor must not change the web prompt: core first, then
    // exactly one blank line, then the canvas/app sections.
    expect(DEFAULT_SYSTEM_PROMPT.startsWith(`${CLI_SYSTEM_PROMPT}\n\n**Canvas convention:**`)).toBe(true);
    expect(DEFAULT_SYSTEM_PROMPT).toContain(CANVAS_STYLE_GUIDELINES);
    expect(DEFAULT_SYSTEM_PROMPT).toContain(".sapiom/harness-context.json");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("**In your very first reply this session**");
    // Anchors that pin the pre-split content shape.
    expect(DEFAULT_SYSTEM_PROMPT.startsWith("You are running in the Sapiom Harness.")).toBe(true);
    expect(DEFAULT_SYSTEM_PROMPT.endsWith("don't act on it unprompted.")).toBe(true);
  });

  it("CLI_SYSTEM_PROMPT is the agent-general core with no canvas/app references", () => {
    expect(CLI_SYSTEM_PROMPT.toLowerCase()).not.toContain("canvas");
    expect(CLI_SYSTEM_PROMPT).not.toContain(".sapiom/canvas");
    expect(CLI_SYSTEM_PROMPT).not.toContain("harness-context.json");
    // The core conventions survive.
    expect(CLI_SYSTEM_PROMPT).toContain("You are running in the Sapiom Harness.");
    expect(CLI_SYSTEM_PROMPT).toContain("**The two MCPs, and when to use each:**");
    expect(CLI_SYSTEM_PROMPT).toContain("**The authoring loop, in order:**");
  });
});
