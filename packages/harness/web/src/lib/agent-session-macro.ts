/**
 * The first message of a session an agent verb starts (pure).
 *
 * Ask, Ask to modify, Ask to fix and the run-attempt debug used to type their
 * text into whatever session was bound to the agent, binding or starting one
 * first (flow-map-chat-overlay.md 4.4b). Now each is a macro: a NEW session at
 * the project root, unbound (design-map-chat.md I2), whose first message names
 * the job and the agent. The agent is context in the message, never a binding,
 * so the session reads the project's CLAUDE.md and skills like any other and
 * the canvas never renders from it.
 *
 * The surfaces' own text ("Walk me through the step of this agent…") says
 * "this agent"; without a binding the session only knows which agent that is
 * because this message says so.
 */
import type { WorkflowInfo } from "@shared/types";

import { describeWorkflowPrompt } from "./describe-prompt";

/** The job a macro session is started for. */
export type AgentMacroKind = "ask" | "modify" | "fix" | "debug" | "describe";

/** One line per job, telling the session how far to go before it stops. */
const JOB_LINE: Record<Exclude<AgentMacroKind, "describe">, string> = {
  ask: "Answer from the agent's source. Read the code before answering, and change no files unless I ask you to.",
  modify:
    "Change the agent as asked. Show me the relevant code and the change you propose before editing, then keep it typechecking.",
  fix: "Fix the agent. Find the cause in its source first, make the smallest change that fixes it, then check the fix (typecheck, or a local run with stubs).",
  debug:
    "Debug this run of the agent. Work out the cause from the run details below and the agent's source before changing anything.",
};

/**
 * The first message for `kind` about `agent`. `text` is what the surface
 * composed (the question, the step context, the run attempt); it is kept
 * verbatim. `describe` ignores `text`: its prompt is the agent's own.
 */
export function agentMacroFirstMessage(
  kind: AgentMacroKind,
  agent: WorkflowInfo,
  text = "",
): string {
  const context = `Agent: "${agent.name}", at ${agent.path}`;
  if (kind === "describe")
    return [context, "", describeWorkflowPrompt(agent)].join("\n");
  const body = text.trim();
  return [context, JOB_LINE[kind], ...(body ? ["", body] : [])].join("\n");
}
