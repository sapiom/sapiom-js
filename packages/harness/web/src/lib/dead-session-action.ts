import type { SessionResumeMode } from "@shared/types";

export type DeadSessionAction = "checking" | "resume" | "continue" | "blocked";

/**
 * Resolves the one truthful primary action for an exited Studio session.
 * Undefined resumeMode means the server-backed history check is still in
 * flight; neither native Resume nor portable Continue is promised until it
 * settles.
 */
export function deadSessionAction(input: {
  hasAgentSessionId: boolean;
  resumeMode: SessionResumeMode | undefined;
  recordReady: boolean;
}): DeadSessionAction {
  if (input.hasAgentSessionId && input.resumeMode === undefined)
    return "checking";
  if (input.hasAgentSessionId && input.resumeMode === "agent-resume")
    return "resume";
  if (input.recordReady) return "continue";
  return "blocked";
}
