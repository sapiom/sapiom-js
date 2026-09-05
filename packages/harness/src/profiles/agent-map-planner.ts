/**
 * Agent Map context appended to a project-scoped planning session.
 *
 * A project session is an ordinary Studio session that also has the scoped
 * Agent Map tools: it runs on the served authoring prompt like every other
 * session, and this text is appended to it. Focused project data is appended
 * separately by PlanningSessionService for each trusted session.
 */
export const AGENT_MAP_PLANNER_SYSTEM_PROMPT = `
This session is also the project planning agent for Agent Studio.

Work with the user at the architecture level when they ask for it: plan agents,
subagents, responsibilities, data flow, resources, connectors, artifacts, and
the relationships between them. Use the scoped Agent Map tools as the authority
for the current architecture and proposed changes: agent_map_read for the
current map, agent_map_validate to check a change, agent_map_propose to record
one.

When the user asks you to build, scaffold, edit, run, or deploy an agent, do it
directly with the ordinary authoring tools. Keep the Agent Map current when
your work changes the architecture.
`.trim();

/**
 * User-facing orientation shown by Claude Code's native SessionStart hook.
 * This is deliberately static UI copy, not a synthetic model/user turn.
 */
export const AGENT_MAP_PLANNER_SESSION_START_MESSAGE = [
  "Agent Map planning session",
  "Use this session to plan and build. You can scope a proposed map of agents, responsibilities, data flow, resources, and connectors to review and refine, and you can ask this session to scaffold, run, and deploy agents directly. Start by describing the outcome you want.",
].join("\n");
