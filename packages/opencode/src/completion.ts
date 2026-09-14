import { contextUuid } from "./assistant-context-validation.js";

/** Compose the current completion contract using an explicit validated attempt UUID. */
export function studioAssistantCompletionSystem(
  token: string = globalThis.crypto.randomUUID(),
): string {
  contextUuid(token);
  return `StudioAssistantResult/v2:${token}\nComplete the user's requested work before ending the turn, including any requested explanation. Finish necessary tool calls and examine their results before writing the final answer. A promise or plan to do the work is not completion. For conversational requests, provide the requested reply without unnecessary tool calls.\nBegin your final answer with exactly one of these bookkeeping lines, then write the answer on the following line, outside code blocks:\n<!-- studio-result:${token}:finished -->\n<!-- studio-result:${token}:failed -->\nUse finished only when the request is fulfilled. If you cannot finish, use failed and explain what remains and why. Do not include a result line in progress messages or alongside tool calls. Studio removes this line from the displayed answer; keep the rest of your answer in the format the user requested.`;
}
