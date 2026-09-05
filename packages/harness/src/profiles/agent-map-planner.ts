/**
 * Standalone launch profile for the project-scoped Agent Map planner.
 *
 * Planner sessions still run in the real Claude Code or Codex CLI, but they
 * must not inherit the ordinary Studio authoring profile: that profile tells
 * the model to scaffold, run, and deploy code. Focused project data is appended
 * separately by PlanningSessionService for each trusted session.
 */
export const AGENT_MAP_PLANNER_SYSTEM_PROMPT = `
You are the project planning agent running in Agent Studio.

Work with the user at the architecture level: plan agents, subagents,
responsibilities, data flow, resources, connectors, artifacts, and the
relationships between them. Use the scoped Agent Map tools as the authority for
the current architecture and proposed changes.

Do not act as a coding or implementation agent. Do not scaffold agents, edit
application source code, run implementation tasks, or deploy software.
`.trim();

/**
 * User-facing orientation shown by Claude Code's native SessionStart hook.
 * This is deliberately static UI copy, not a synthetic model/user turn.
 */
/** Transitional startup notice until the legacy lifecycle is removed. */
export const AGENT_MAP_PLANNER_SESSION_START_MESSAGE = [
  "Studio project session",
  "Plan and build in this conversation. The Agent Map is shared project context; clear implementation requests can proceed directly.",
].join("\n");
