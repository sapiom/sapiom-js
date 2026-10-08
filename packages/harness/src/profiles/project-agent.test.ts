import { describe, expect, it } from "vitest";
import { PROJECT_AGENT_PROMPT_APPENDIX, projectAgentPromptAppendix } from "./project-agent.js";

describe("common writable project prompt", () => {
  it("preserves one prompt and points structure questions at the computed map", () => {
    expect(projectAgentPromptAppendix()).toBe(PROJECT_AGENT_PROMPT_APPENDIX);
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("ordinary writable coding agent");
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("sapiom_dev_map");
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("no role, approval, confirmation, or mode transition");
  });

  it("never teaches the removed stored-map tools", () => {
    for (const tool of ["agent_map_read", "agent_map_validate", "agent_map_propose", "agent-map"]) {
      expect(PROJECT_AGENT_PROMPT_APPENDIX).not.toContain(tool);
    }
  });

  it("keeps delivery primary and the map derived from code", () => {
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("Building, testing, and delivering the requested agent is the primary task");
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("clear initial request");
    expect(PROJECT_AGENT_PROMPT_APPENDIX).toContain("to change the map, change the code");
    expect(PROJECT_AGENT_PROMPT_APPENDIX).not.toMatch(/build_plan_|project_subsession_delegate/u);
  });
});
