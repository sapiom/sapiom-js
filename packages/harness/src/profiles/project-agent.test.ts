import { describe, expect, it } from "vitest";
import { PROJECT_AGENT_PROMPT_APPENDIX, projectAgentPromptAppendix } from "./project-agent.js";

describe("common writable project prompt", () => {
  it("preserves one prompt and the current map tool guidance", () => {
    expect(projectAgentPromptAppendix()).toBe(PROJECT_AGENT_PROMPT_APPENDIX);
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("ordinary writable coding agent");
    for (const tool of ["agent_map_read", "agent_map_validate", "agent_map_propose"]) {
      expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain(tool);
    }
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("no role, approval, confirmation, or mode transition");
  });
});
